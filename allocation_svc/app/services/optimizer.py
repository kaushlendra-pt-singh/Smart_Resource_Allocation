import json
import logging
from bson import ObjectId
from typing import List, Dict, Any, Optional
import numpy as np
from scipy.optimize import linprog

from app.core.config import settings
from app.core.redis import redis_client
from app.core.db import mongo_db
from app.utils.geo import haversine_distance

logger = logging.getLogger(settings.APP_NAME)


def has_owner_tier(warehouse_ngo_id: str, requesting_ngo_id: str, user_role: str) -> bool:
    """
    True if the requester may dip into the owner-protected stock (reservedQuantity).
    Single source of truth: used by the optimizer AND sent to res_manage_svc on reserve.
    """
    is_owner = warehouse_ngo_id == requesting_ngo_id
    is_privileged = user_role in {"NGO_ADMIN", "SUPER_ADMIN"}
    return (is_owner and is_privileged) or user_role == "SUPER_ADMIN"


class WarehouseCandidate:
    """
    Represents a candidate warehouse fetched from Redis or MongoDB.
    """

    def __init__(
        self,
        inventory_id: str,
        warehouse_name: str,
        ngo_id: str,
        resource_id: str,
        total_quantity: int,
        reserved_quantity: int,
        available_quantity: int,
        coordinates: List[float],
        allocated_quantity: int = 0,
    ):
        self.allocated_quantity = allocated_quantity
        self.inventory_id = inventory_id
        self.warehouse_name = warehouse_name
        self.ngo_id = ngo_id
        self.resource_id = resource_id
        self.total_quantity = total_quantity
        self.reserved_quantity = reserved_quantity
        self.available_quantity = available_quantity
        self.coordinates = coordinates

    def calculate_usable_stock(self, requesting_ngo_id: str, user_role: str) -> int:
        """
        Field meanings:
        - total_quantity:     physical stock
        - allocated_quantity: units currently held by active allocations
        - reserved_quantity:  minimum stock protected for the OWNER NGO
        NGO Access Tier Rules:
        - Owner tier (owner NGO_ADMIN / SUPER_ADMIN): total - allocated
        - Everyone else: total - allocated - reserved (available_quantity)
        """
        return max(0, self.total_quantity - self.allocated_quantity)


class OptimizationResult:
    """
    Output payload of a single item allocation decision.
    """

    def __init__(
        self,
        resource_id: str,
        requested_quantity: int,
        total_allocated: int,
        is_fully_allocated: bool,
        allocations: List[Dict[str, Any]],
    ):
        self.resource_id = resource_id
        self.requested_quantity = requested_quantity
        self.total_allocated = total_allocated
        self.is_fully_allocated = is_fully_allocated
        self.allocations = allocations


CACHE_TTL_SECONDS = 300  # short TTL: stock changes with every reservation
MAX_HYDRATE = 1000  # max inventories per resource we are willing to index in Redis


def _stock_key(wh_name: str, resource_id: str) -> str:
    return f"stock:wh:{wh_name}:res:{resource_id}"


def _index_key(resource_id: str) -> str:
    # Set of warehouse names that hold this resource. Only written when it is COMPLETE
    # for the resource, so its existence proves the cache can be trusted.
    return f"idx:res:{resource_id}:warehouses"


def _to_str(raw: Any) -> str:
    if isinstance(raw, bytes):
        return raw.decode("utf-8")
    if isinstance(raw, str):
        return raw
    return str(getattr(raw, "member", raw))


def _dedupe(candidates: List[WarehouseCandidate]) -> List[WarehouseCandidate]:
    """Guarantee one entry per inventory so the optimizer can never double-allocate stock."""
    seen: set = set()
    unique: List[WarehouseCandidate] = []
    for c in candidates:
        if c.inventory_id in seen:
            continue
        seen.add(c.inventory_id)
        unique.append(c)
    return unique


async def invalidate_stock_cache(entries: List[tuple]) -> None:
    """
    Drop cached stock after reservations/rollbacks.
    entries: [(resource_id, warehouse_name), ...]
    A missing stock key makes the next lookup fall back to MongoDB and re-hydrate.
    """
    keys = list({_stock_key(wh, rid) for rid, wh in entries})
    if not keys:
        return
    try:
        await redis_client.delete(*keys)
    except Exception as e:
        logger.warning(f"[optimizer] Failed to invalidate stock cache: {e}")


async def _load_candidates_from_redis(
    resource_id: str, target_location: Optional[List[float]], radius_km: float
) -> Optional[List[WarehouseCandidate]]:
    """
    Returns candidates ONLY if the cache is provably complete and valid for this
    resource; otherwise None (caller must use MongoDB). Never returns partial data.
    """
    if not target_location:
        return None
    try:
        indexed = await redis_client.smembers(_index_key(resource_id))
        if not indexed:
            return None  # never hydrated / expired
        indexed_names = {_to_str(n) for n in indexed}

        nearby: Any = await redis_client.geosearch(
            "geo:warehouses",
            longitude=target_location[0],
            latitude=target_location[1],
            radius=radius_km,
            unit="km",
        )
        nearby_names = {_to_str(n) for n in (nearby or [])}

        relevant = sorted(nearby_names & indexed_names)
        if not relevant:
            return None  # let MongoDB confirm "no stock nearby"

        blobs = await redis_client.mget([_stock_key(n, resource_id) for n in relevant])

        candidates: List[WarehouseCandidate] = []
        for wh_name, blob in zip(relevant, blobs):
            if not blob:
                return None  # expired or invalidated entry -> cache incomplete
            data = json.loads(blob)
            coords = data["location"]["coordinates"]
            total_q = int(data["totalQuantity"])
            res_q = int(data["reservedQuantity"])
            alloc_q = int(data["allocatedQuantity"])  # missing (old cache entry) -> Mongo fallback
            candidates.append(
                WarehouseCandidate(
                    inventory_id=str(data["inventoryId"]),
                    warehouse_name=wh_name,
                    ngo_id=str(data["ngoId"]),
                    resource_id=str(data["resourceId"]),
                    total_quantity=total_q,
                    reserved_quantity=res_q,
                    allocated_quantity=alloc_q,
                    available_quantity=max(0, total_q - alloc_q - res_q),
                    coordinates=coords,
                )
            )
        return candidates

    except Exception as e:
        logger.warning(f"[optimizer] Redis cache unusable: {e}. Falling back to MongoDB.")
        return None


def _doc_to_candidate(doc: Dict[str, Any], resource_id: str) -> WarehouseCandidate:
    total_q = int(doc.get("totalQuantity", 0))
    res_q = int(doc.get("reservedQuantity", 0))
    alloc_q = int(doc.get("allocatedQuantity", 0))
    return WarehouseCandidate(
        inventory_id=str(doc["_id"]),
        warehouse_name=str(doc.get("warehouseName", "Unknown_Warehouse")),
        ngo_id=str(doc.get("ngoId", "")),
        resource_id=resource_id,
        total_quantity=total_q,
        reserved_quantity=res_q,
        allocated_quantity=alloc_q,
        available_quantity=max(0, total_q - alloc_q - res_q),
        coordinates=doc.get("location", {}).get("coordinates", [0.0, 0.0]),
    )


async def _rehydrate_cache(resource_id: str, candidates: List[WarehouseCandidate]) -> None:
    """Write the COMPLETE set of inventories for a resource to Redis (stock + geo + index)."""
    if not candidates:
        return
    try:
        index_key = _index_key(resource_id)
        await redis_client.delete(index_key)
        for c in candidates:
            payload = json.dumps(
                {
                    "inventoryId": c.inventory_id,
                    "ngoId": c.ngo_id,
                    "resourceId": resource_id,
                    "totalQuantity": c.total_quantity,
                    "reservedQuantity": c.reserved_quantity,
                    "allocatedQuantity": c.allocated_quantity,
                    "availableQuantity": c.available_quantity,
                    "location": {"coordinates": c.coordinates},
                }
            )
            await redis_client.set(
                _stock_key(c.warehouse_name, resource_id), payload, ex=CACHE_TTL_SECONDS
            )
            await redis_client.geoadd(
                "geo:warehouses", (c.coordinates[0], c.coordinates[1], c.warehouse_name)
            )
            await redis_client.sadd(index_key, c.warehouse_name)
        await redis_client.expire(index_key, CACHE_TTL_SECONDS)
    except Exception as cache_err:
        logger.warning(f"[optimizer] Failed to re-hydrate Redis cache: {cache_err}")


async def _load_candidates_from_mongo(
    resource_id: str, target_location: Optional[List[float]], radius_km: float
) -> List[WarehouseCandidate]:
    if not ObjectId.is_valid(resource_id):
        logger.error(f"[optimizer] Invalid resource ID: {resource_id}")
        return []

    if mongo_db.db is None:
        logger.error("[db] MongoDB connection is not initialized.")
        return []

    collection = mongo_db.db["inventories"]
    base_query: dict = {"resourceId": ObjectId(resource_id), "totalQuantity": {"$gt": 0}}

    # Load ALL inventories for the resource so the Redis index is complete and
    # valid for any later location/radius. Distance filtering happens below.
    docs = await collection.find(base_query).to_list(length=MAX_HYDRATE + 1)
    complete = len(docs) <= MAX_HYDRATE

    if not complete:
        # Too many to index -> bounded geo query, and do NOT write a Redis index.
        geo_query = dict(base_query)
        if target_location:
            geo_query["location.coordinates"] = {
                "$near": {
                    "$geometry": {"type": "Point", "coordinates": target_location},
                    "$maxDistance": radius_km * 1000,  # km -> meters
                }
            }
        docs = await collection.find(geo_query).to_list(length=100)
        return _dedupe([_doc_to_candidate(d, resource_id) for d in docs])

    all_candidates = _dedupe([_doc_to_candidate(d, resource_id) for d in docs])
    await _rehydrate_cache(resource_id, all_candidates)

    if not target_location:
        return all_candidates
    return [
        c
        for c in all_candidates
        if haversine_distance(target_location, c.coordinates) <= radius_km
    ]


async def fetch_candidate_warehouses(
    resource_id: str, target_location: Optional[List[float]], radius_km: float = 50.0, user_role: str = "USER"
) -> List[WarehouseCandidate]:
    """
    Cache-aside with a correctness guarantee:
    - Redis is used only when it is provably complete for this resource
      (index set present, every nearby warehouse has a live stock entry).
    - Anything else (miss, expiry, invalidation, malformed data, error) -> MongoDB,
      which is authoritative, and the cache is rebuilt from the full result.
    - Result is de-duplicated per inventory so stock can never be double-allocated.
    """
    cached = await _load_candidates_from_redis(resource_id, target_location, radius_km)
    if cached is not None:
        logger.info(f"[optimizer] Retrieved {len(cached)} candidates from Redis cache.")
        return _dedupe(cached)

    logger.info("[optimizer] Fetching inventory candidates directly from MongoDB...")
    return await _load_candidates_from_mongo(resource_id, target_location, radius_km)


class SpatialOptimizer:
    """
    Optimization engine solving multi-hub warehouse allocation.
    Uses SciPy Linear Programming to minimize total transport distance.
    """

    @staticmethod
    def solve_single_resource_allocation(
        resource_id: str,
        requested_quantity: int,
        requesting_ngo_id: str,
        target_location: Optional[List[float]],
        candidates: List[WarehouseCandidate],
        preferred_warehouse_name: Optional[str] = None,
        user_role: str="USER",
        allow_partial_fulfillment: bool = False
    ) -> OptimizationResult:
        """
        Calculates optimal warehouse splits to satisfy requested_quantity.
        """
        if not candidates or requested_quantity <= 0:
            return OptimizationResult(
                resource_id=resource_id,
                requested_quantity=requested_quantity,
                total_allocated=0,
                is_fully_allocated=False,
                allocations=[],
            )

        # 1. Filter out candidates with 0 usable stock
        usable_candidates: List[Dict[str, Any]] = []
        for c in candidates:
            usable_qty = c.calculate_usable_stock(requesting_ngo_id, user_role=user_role)
            if usable_qty > 0:
                dist = (
                    haversine_distance(target_location, c.coordinates)
                    if target_location
                    else 0.0
                )
                usable_candidates.append(
                    {
                        "candidate": c,
                        "usable_qty": usable_qty,
                        "distance_km": dist,
                        "is_preferred": (
                            preferred_warehouse_name is not None
                            and c.warehouse_name.lower()
                            == preferred_warehouse_name.lower()
                        ),
                    }
                )

        if not usable_candidates:
            return OptimizationResult(
                resource_id=resource_id,
                requested_quantity=requested_quantity,
                total_allocated=0,
                is_fully_allocated=False,
                allocations=[],
            )
        # Rank: nearest first; when equally near (or no location given), more stock first
        usable_candidates.sort(key=lambda x: (x["distance_km"], -x["usable_qty"]))

        # If partial fulfillment is not allowed, one warehouse
        # must be capable of fulfilling the entire request.
        if not allow_partial_fulfillment:
            full_stock_candidates = [
                item
                for item in usable_candidates
                if item["usable_qty"] >= requested_quantity
            ]

            if not full_stock_candidates:
                return OptimizationResult(
                    resource_id=resource_id,
                    requested_quantity=requested_quantity,
                    total_allocated=0,
                    is_fully_allocated=False,
                    allocations=[],
                )

            # Prefer the preferred warehouse if one can fulfill everything.
            if preferred_warehouse_name:
                preferred_full = [
                    item
                    for item in full_stock_candidates
                    if item["is_preferred"]
                ]
                if preferred_full:
                    full_stock_candidates = preferred_full

            # Otherwise choose the nearest capable warehouse.
            # nearest warehouse that can cover everything; ties -> more stock
            full_stock_candidates.sort(key=lambda x: (x["distance_km"], -x["usable_qty"]))
            item = full_stock_candidates[0]

            c: WarehouseCandidate = item["candidate"]

            allocations = [
                {
                    "inventoryId": c.inventory_id,
                    "warehouseName": c.warehouse_name,
                    "ngoId": c.ngo_id,
                    "isOwnNgoWarehouse": (c.ngo_id == requesting_ngo_id),
                    "allocatedQuantity": requested_quantity,
                    "distanceKm": item["distance_km"],
                    "warehouseCoordinates": c.coordinates,
                }
            ]

            return OptimizationResult(
                resource_id=resource_id,
                requested_quantity=requested_quantity,
                total_allocated=requested_quantity,
                is_fully_allocated=True,
                allocations=allocations,
            )

        allocations: List[Dict[str, Any]] = []
        remaining_needed = requested_quantity

        # 2. Preferred Warehouse First Pass (if requested)
        if preferred_warehouse_name:
            pref_matches = [item for item in usable_candidates if item["is_preferred"]]
            for item in pref_matches:
                if remaining_needed <= 0:
                    break
                c: WarehouseCandidate = item["candidate"]
                alloc_qty = min(remaining_needed, item["usable_qty"])

                allocations.append(
                    {
                        "inventoryId": c.inventory_id,
                        "warehouseName": c.warehouse_name,
                        "ngoId": c.ngo_id,
                        "isOwnNgoWarehouse": (c.ngo_id == requesting_ngo_id),
                        "allocatedQuantity": alloc_qty,
                        "distanceKm": item["distance_km"],
                        "warehouseCoordinates": c.coordinates,
                    }
                )

                item["usable_qty"] -= alloc_qty
                remaining_needed -= alloc_qty

        # Return early if preferred warehouse fully satisfied request
        if remaining_needed <= 0:
            return OptimizationResult(
                resource_id=resource_id,
                requested_quantity=requested_quantity,
                total_allocated=requested_quantity,
                is_fully_allocated=True,
                allocations=allocations,
            )

        # 3. Greedy fill: nearest first, ties -> more stock first
        remaining_candidates = sorted(
            (item for item in usable_candidates if item["usable_qty"] > 0),
            key=lambda x: (x["distance_km"], -x["usable_qty"]),
        )
        for item in remaining_candidates:
            if remaining_needed <= 0:
                break
            cand: WarehouseCandidate = item["candidate"]
            alloc_qty = min(remaining_needed, item["usable_qty"])
            allocations.append(
                {
                    "inventoryId": cand.inventory_id,
                    "warehouseName": cand.warehouse_name,
                    "ngoId": cand.ngo_id,
                    "isOwnNgoWarehouse": (cand.ngo_id == requesting_ngo_id),
                    "allocatedQuantity": alloc_qty,
                    "distanceKm": item["distance_km"],
                    "warehouseCoordinates": cand.coordinates,
                }
            )
            remaining_needed -= alloc_qty

        total_allocated = requested_quantity - max(0, remaining_needed)
        return OptimizationResult(
            resource_id=resource_id,
            requested_quantity=requested_quantity,
            total_allocated=total_allocated,
            is_fully_allocated=(total_allocated >= requested_quantity),
            allocations=allocations,
        )


# Export a singleton instance
optimizer = SpatialOptimizer()