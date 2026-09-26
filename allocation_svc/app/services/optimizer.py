import json
import logging
from typing import List, Dict, Any, Optional
import numpy as np
from scipy.optimize import linprog

from app.core.config import settings
from app.core.redis import redis_client
from app.core.db import mongo_db
from app.utils.geo import haversine_distance

logger = logging.getLogger(settings.APP_NAME)


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
    ):
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
        NGO Access Tier Rules:
        - Owning NGO: Access to total_quantity (available + reserved).
        - Non-Owning NGO: Access strictly to available_quantity (liquid unreserved stock).
        """
        is_owner = self.ngo_id == requesting_ngo_id
        is_privileged = user_role in {"NGO_ADMIN", "SUPER_ADMIN"}
        if (is_owner and is_privileged) or user_role == "SUPER_ADMIN":
            return max(0, self.total_quantity)
        return max(0, self.available_quantity)


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


async def fetch_candidate_warehouses(
    resource_id: str, target_location: Optional[List[float]], radius_km: float = 50.0, user_role: str="USER"
) -> List[WarehouseCandidate]:
    """
    Fetches candidate warehouses using Cache-Aside strategy:
    1. Query Redis GEO index + JSON stock cache.
    2. Fall back to MongoDB Motor $near query on cache miss.
    3. Dynamically re-hydrate Redis cache.
    """
    candidates: List[WarehouseCandidate] = []

    # 1. Try Redis Geo Search & Cache Lookup
    try:
        if target_location:
            nearby_warehouses: Any = await redis_client.geosearch(
                "geo:warehouses",
                longitude=target_location[0],
                latitude=target_location[1],
                radius=radius_km,
                unit="km",
            )

            if nearby_warehouses:
                for raw_item in nearby_warehouses:
                    # Type-safe extraction of member string across redis-py response types
                    if isinstance(raw_item, bytes):
                        wh_name = raw_item.decode("utf-8")
                    elif isinstance(raw_item, str):
                        wh_name = raw_item
                    else:
                        wh_name = str(getattr(raw_item, "member", raw_item))

                    cache_key = f"stock:wh:{wh_name}:res:{resource_id}"
                    cached_data = await redis_client.get(cache_key)

                    if cached_data:
                        data = json.loads(cached_data)
                        candidates.append(
                            WarehouseCandidate(
                                inventory_id=str(data["inventoryId"]),
                                warehouse_name=wh_name,
                                ngo_id=str(data["ngoId"]),
                                resource_id=str(data["resourceId"]),
                                total_quantity=int(data["totalQuantity"]),
                                reserved_quantity=int(data["reservedQuantity"]),
                                available_quantity=int(data["availableQuantity"]),
                                coordinates=data.get("location", {}).get(
                                    "coordinates", target_location
                                )
                            )
                        )

        if candidates:
            logger.info(
                f"[optimizer] Retrieved {len(candidates)} candidates from Redis cache."
            )
            return candidates

    except Exception as e:
        logger.warning(
            f"[optimizer] Redis cache miss or error: {e}. Falling back to MongoDB."
        )

    # 2. Fallback to MongoDB Motor Query
    logger.info("[optimizer] Fetching inventory candidates directly from MongoDB...")
    query: dict = {"resourceId": resource_id, "totalQuantity": {"$gt": 0}}

    if target_location:
        query["location"] = {
            "$near": {
                "$geometry": {"type": "Point", "coordinates": target_location},
                "$maxDistance": radius_km * 1000,  # Convert km to meters
            }
        }

    if mongo_db.db is None:
        logger.error("[db] MongoDB connection is not initialized.")
        return []

    cursor = mongo_db.db["inventory"].find(query)
    mongo_docs = await cursor.to_list(length=100)

    for doc in mongo_docs:
        total_q = int(doc.get("totalQuantity", 0))
        res_q = int(doc.get("reservedQuantity", 0))
        avail_q = max(0, total_q - res_q)
        coords = doc.get("location", {}).get("coordinates", [0.0, 0.0])
        wh_name = str(doc.get("warehouseName", "Unknown_Warehouse"))
        inv_id = str(doc["_id"])
        ngo_id = str(doc.get("ngoId", ""))

        cand = WarehouseCandidate(
            inventory_id=inv_id,
            warehouse_name=wh_name,
            ngo_id=ngo_id,
            resource_id=resource_id,
            total_quantity=total_q,
            reserved_quantity=res_q,
            available_quantity=avail_q,
            coordinates=coords
        )
        candidates.append(cand)

        # 3. Re-hydrate Redis Cache
        try:
            payload = json.dumps(
                {
                    "inventoryId": inv_id,
                    "ngoId": ngo_id,
                    "resourceId": resource_id,
                    "totalQuantity": total_q,
                    "reservedQuantity": res_q,
                    "availableQuantity": avail_q,
                    "location": {"coordinates": coords},
                }
            )
            await redis_client.set(
                f"stock:wh:{wh_name}:res:{resource_id}", payload, ex=86400
            )
            await redis_client.geoadd("geo:warehouses", (coords[0], coords[1], wh_name))
        except Exception as cache_err:
            logger.warning(f"[optimizer] Failed to re-hydrate Redis cache: {cache_err}")

    return candidates


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

        # 3. Optimize remaining deficit across candidate pool
        remaining_candidates = [
            item for item in usable_candidates if item["usable_qty"] > 0
        ]

        if remaining_candidates:
            remaining_candidates.sort(key=lambda x: x["distance_km"])

            num_warehouses = len(remaining_candidates)
            c_cost = np.array([item["distance_km"] for item in remaining_candidates])
            c_capacities = np.array(
                [item["usable_qty"] for item in remaining_candidates]
            )

            total_available = int(np.sum(c_capacities))
            if total_available < requested_quantity and not allow_partial_fulfillment:
                return OptimizationResult(
                    resource_id=resource_id,
                    requested_quantity=requested_quantity,
                    total_allocated=0,
                    is_fully_allocated=False,
                    allocations=[],
                )
            target_alloc = min(remaining_needed, total_available)

            # Linear Program formulation using HiGHS solver
            A_eq = np.ones((1, num_warehouses))
            b_eq = np.array([target_alloc])
            bounds = [(0, cap) for cap in c_capacities]

            res = linprog(c=c_cost, A_eq=A_eq, b_eq=b_eq, bounds=bounds, method="highs")

            if res.success:
                solution_allocs = np.round(res.x).astype(int)
                for idx, qty in enumerate(solution_allocs):
                    if qty > 0:
                        item = remaining_candidates[idx]
                        cand: WarehouseCandidate = item["candidate"]
                        allocations.append(
                            {
                                "inventoryId": cand.inventory_id,
                                "warehouseName": cand.warehouse_name,
                                "ngoId": cand.ngo_id,
                                "isOwnNgoWarehouse": (cand.ngo_id == requesting_ngo_id),
                                "allocatedQuantity": int(qty),
                                "distanceKm": item["distance_km"],
                                "warehouseCoordinates": cand.coordinates,
                            }
                        )
                        remaining_needed -= int(qty)
            else:
                # Deterministic greedy fallback if solver hits edge cases
                logger.warning(
                    f"[optimizer] LP solver fallback triggered: {res.message}"
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
