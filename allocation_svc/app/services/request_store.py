"""
request_store.py - persistence for allocation requests (collection: allocation_requests).

One document per allocation request. The request's `referenceId` ("ALLOC-XXXXXXXX") is its public id and
is ALSO the `referenceId` written to res_manage_svc's ledger, so ledger rows trace back to a request.

Document shape
--------------
{
  referenceId, requesterNgoId, requestedBy, requesterRole,
  createdAt,                                  # = requested time
  items: [{resourceId, requestedQuantity}],   # what was asked
  lines: [{                                   # what was planned, one line per warehouse
      lineId, resourceId, inventoryId, warehouseName,
      ngoId,                                  # OWNER of the warehouse = who decides
      quantity, distanceKm, warehouseCoordinates,
      status,                                 # see below
      decidedAt, decidedBy, note              # set on approve / reject (or auto-approve)
  }]
}

Line statuses
-------------
PENDING     waiting for the owning NGO's decision, NOTHING is held
APPROVED    stock is held (allocatedQuantity raised in res_manage_svc), waiting for the truck
REJECTED    owner said no, nothing was held
CANCELLED   released / withdrawn
DISPATCHED  truck left, hold turned into shipped stock
PROCESSING  internal and short-lived: a line is "claimed" while we call res_manage_svc, so two people
            can never act on the same line at once. It is shown as pending-like.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from pymongo import ASCENDING, DESCENDING

from app.core.config import settings
from app.core.db import mongo_db

logger = logging.getLogger(settings.APP_NAME)

COLLECTION = "allocation_requests"

PENDING = "PENDING"
PROCESSING = "PROCESSING"
APPROVED = "APPROVED"
REJECTED = "REJECTED"
CANCELLED = "CANCELLED"
DISPATCHED = "DISPATCHED"
LINE_STATUSES = {PENDING, PROCESSING, APPROVED, REJECTED, CANCELLED, DISPATCHED}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _col():
    if mongo_db.db is None:
        raise RuntimeError("MongoDB connection is not initialized.")
    return mongo_db.db[COLLECTION]


async def create_indexes() -> None:
    """Called once at startup (main.py lifespan). Index problems must not stop the service."""
    try:
        col = _col()
        await col.create_index("referenceId", unique=True)
        # "my requests"
        await col.create_index([("requesterNgoId", ASCENDING), ("createdAt", DESCENDING)])
        # "incoming requests for my warehouses" (both fields live in the same array -> allowed)
        await col.create_index(
            [("lines.ngoId", ASCENDING), ("lines.status", ASCENDING), ("createdAt", DESCENDING)]
        )
        logger.info(f"[request_store] Indexes ready on {COLLECTION}.")
    except Exception as e:
        logger.error(f"[request_store] Could not create indexes on {COLLECTION}: {e}")


def new_line(
    *,
    resource_id: str,
    inventory_id: str,
    warehouse_name: str,
    ngo_id: str,
    quantity: int,
    distance_km: float,
    coordinates: List[float],
    status: str = PENDING,
) -> Dict[str, Any]:
    """Builds one request line. Status is PENDING (needs owner decision) or PROCESSING (auto-hold in progress)."""
    return {
        "lineId": uuid.uuid4().hex[:10],
        "resourceId": resource_id,
        "inventoryId": inventory_id,
        "warehouseName": warehouse_name,
        "ngoId": ngo_id,
        "quantity": quantity,
        "distanceKm": distance_km,
        "warehouseCoordinates": coordinates,
        "status": status,
        "decidedAt": None,
        "decidedBy": None,
        "note": None,
    }


async def create_request(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Inserts the request (createdAt is set here) and returns it without Mongo's _id."""
    doc.setdefault("createdAt", utcnow())
    await _col().insert_one(doc)
    doc.pop("_id", None)  # insert_one adds _id in place; callers should not see it
    return doc


async def get_request(reference_id: str) -> Optional[Dict[str, Any]]:
    return await _col().find_one({"referenceId": reference_id}, {"_id": 0})


async def list_requests(
    query: Dict[str, Any], page: int, limit: int
) -> Tuple[List[Dict[str, Any]], int]:
    """Newest first. Returns (documents, total_matching)."""
    col = _col()
    total = await col.count_documents(query)
    cursor = (
        col.find(query, {"_id": 0})
        .sort("createdAt", DESCENDING)
        .skip((page - 1) * limit)
        .limit(limit)
    )
    docs = await cursor.to_list(length=limit)
    return docs, total


async def set_line_status(
    reference_id: str,
    line_id: str,
    from_statuses: Iterable[str],
    to_status: str,
    extra: Optional[Dict[str, Any]] = None,
) -> bool:
    """
    Atomic compare-and-set on ONE line: changes it only if it is currently in one of `from_statuses`.
    Returns True if this call changed it, False if someone else got there first (or it does not exist).
    This is what makes "claim, call res_manage_svc, then finish or revert" safe against double clicks.
    """
    fields: Dict[str, Any] = {"lines.$.status": to_status}
    for key, value in (extra or {}).items():
        fields[f"lines.$.{key}"] = value

    result = await _col().update_one(
        {
            "referenceId": reference_id,
            "lines": {"$elemMatch": {"lineId": line_id, "status": {"$in": list(from_statuses)}}},
        },
        {"$set": fields},
    )
    return result.modified_count == 1


def find_line(doc: Dict[str, Any], line_id: str) -> Optional[Dict[str, Any]]:
    for line in doc.get("lines", []):
        if line.get("lineId") == line_id:
            return line
    return None


def derive_status(lines: List[Dict[str, Any]]) -> str:
    """One overall status for display, derived from the lines (never stored, so it cannot go stale)."""
    if not lines:
        return "NO_STOCK"
    statuses: set[str] = {str(l["status"]) for l in lines if l.get("status")}
    if statuses & {PENDING, PROCESSING}:
        return PENDING
    if APPROVED in statuses:
        return APPROVED  # holds are active, waiting for dispatch
    if len(statuses) == 1:
        return next(iter(statuses))  # all DISPATCHED / all REJECTED / all CANCELLED
    return "CLOSED"  # mix of finished outcomes