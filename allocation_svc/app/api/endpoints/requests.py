"""
requests.py - allocation request endpoints (mounted at /allocation/api/requests).

  GET  /requests?view=mine|incoming|all&status=&page=&limit=   list
  GET  /requests/{referenceId}                                  detail
  POST /requests/{referenceId}/lines/{lineId}/approve           owner NGO admin / super admin
  POST /requests/{referenceId}/lines/{lineId}/reject            owner NGO admin / super admin
  POST /requests/{referenceId}/lines/{lineId}/cancel            requester / owner admin / super admin
  POST /requests/{referenceId}/lines/{lineId}/dispatch          owner NGO admin or worker / super admin

Rules:
- A line belongs to the NGO that OWNS the warehouse (line.ngoId). That NGO decides.
- PENDING lines hold nothing. The hold starts at approval (reserve in res_manage_svc) and ends at
  dispatch (stock ships) or cancel (stock is released).
- Approval reserves with includeOwnerReserve=True: the approver is the owner (or super admin), so the
  owner-protected stock may be given away. reservedQuantity itself is never changed.
- Every transition is "claim -> call res_manage_svc -> finish or revert" using a short-lived PROCESSING
  status, so two people can never act on the same line at once.
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.security import require_ngo_worker
from app.services import request_store as store
from app.services.optimizer import invalidate_stock_cache
from app.services.res_client import res_client

logger = logging.getLogger(settings.APP_NAME)
router = APIRouter()


class NoteBody(BaseModel):
    note: Optional[str] = Field(None, max_length=500, description="Optional reason / comment")


# --------------------------------------------------------------------------- helpers
def _uid(user: Dict[str, Any]) -> str:
    return str(user.get("_id") or user.get("userId") or "unknown")


def _role(user: Dict[str, Any]) -> str:
    return str(user.get("role", "")).upper()


def _ngo(user: Dict[str, Any]) -> str:
    return str(user.get("ngoId") or "")


def _is_super(user: Dict[str, Any]) -> bool:
    return _role(user) == "SUPER_ADMIN"


def _is_admin_of(user: Dict[str, Any], ngo_id: str) -> bool:
    return _role(user) == "NGO_ADMIN" and bool(_ngo(user)) and _ngo(user) == ngo_id


def _is_staff_of(user: Dict[str, Any], ngo_id: str) -> bool:
    return _role(user) in {"NGO_ADMIN", "NGO_WORKER"} and bool(_ngo(user)) and _ngo(user) == ngo_id


def _can_see(user: Dict[str, Any], doc: Dict[str, Any]) -> bool:
    if _is_super(user):
        return True
    my_ngo = _ngo(user)
    if not my_ngo:
        return False
    return doc.get("requesterNgoId") == my_ngo or any(
        l.get("ngoId") == my_ngo for l in doc.get("lines", [])
    )


def _iso(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat().replace("+00:00", "Z")
    return value


def _present(doc: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
    """The requester sees every line; an owner NGO only sees the lines on its own warehouses."""
    my_ngo = _ngo(user)
    sees_all = _is_super(user) or (bool(my_ngo) and doc.get("requesterNgoId") == my_ngo)
    all_lines = doc.get("lines", [])
    lines = all_lines if sees_all else [l for l in all_lines if l.get("ngoId") == my_ngo]
    return {
        "referenceId": doc.get("referenceId"),
        "requesterNgoId": doc.get("requesterNgoId"),
        "requestedBy": doc.get("requestedBy"),
        "requestedAt": _iso(doc.get("createdAt")),
        "status": store.derive_status(lines),
        "items": doc.get("items", []),
        "lines": [{**l, "decidedAt": _iso(l.get("decidedAt"))} for l in lines],
    }


async def _load(reference_id: str, user: Dict[str, Any]) -> Dict[str, Any]:
    doc = await store.get_request(reference_id)
    if not doc or not _can_see(user, doc):  # same answer for "missing" and "not yours"
        raise HTTPException(status_code=404, detail="Request not found.")
    return doc


def _need_line(doc: Dict[str, Any], line_id: str) -> Dict[str, Any]:
    line = store.find_line(doc, line_id)
    if not line:
        raise HTTPException(status_code=404, detail="Request line not found.")
    return line


def _error_from(resp: Dict[str, Any], default: str) -> HTTPException:
    """res_manage_svc said no: 409 if it was a stock/state conflict, 502 if the service is unreachable/broken."""
    code = 409 if resp.get("statusCode") == 409 else 502
    return HTTPException(status_code=code, detail=resp.get("message") or default)


async def _revert(reference_id: str, line_id: str, to_status: str) -> None:
    """Gives a claimed (PROCESSING) line back its previous status."""
    try:
        await store.set_line_status(reference_id, line_id, [store.PROCESSING], to_status)
    except Exception:
        logger.exception(f"[requests] COULD NOT REVERT line {line_id} of {reference_id} to {to_status}")


async def _ok(message: str, reference_id: str, user: Dict[str, Any]) -> Dict[str, Any]:
    fresh = await store.get_request(reference_id)
    return {"status": "success", "message": message, "data": _present(fresh, user) if fresh else None}


# --------------------------------------------------------------------------- read
@router.get("", summary="List allocation requests")
async def list_requests(
    view: Literal["mine", "incoming", "all"] = Query(
        "mine", description="mine = requested by my NGO, incoming = lines on my NGO's warehouses, all = super admin only"
    ),
    line_status: Optional[str] = Query(None, alias="status", description="Filter by line status"),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    user: Dict[str, Any] = Depends(require_ngo_worker),
):
    st = line_status.upper() if line_status else None
    if st and st not in store.LINE_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(store.LINE_STATUSES)}")

    my_ngo = _ngo(user)
    if view == "all":
        if not _is_super(user):
            raise HTTPException(status_code=403, detail="Only a super admin can list all requests.")
        query: Dict[str, Any] = {"lines.status": st} if st else {}
    else:
        if not my_ngo:
            raise HTTPException(status_code=403, detail="Your token has no ngoId.")
        if view == "mine":
            query = {"requesterNgoId": my_ngo}
            if st:
                query["lines.status"] = st
        else:  # incoming
            match: Dict[str, Any] = {"ngoId": my_ngo}
            if st:
                match["status"] = st
            query = {"lines": {"$elemMatch": match}}

    docs, total = await store.list_requests(query, page, limit)
    return {
        "status": "success",
        "data": [_present(d, user) for d in docs],
        "pagination": {
            "totalItems": total,
            "currentPage": page,
            "pageSize": limit,
            "totalPages": (total + limit - 1) // limit,
        },
    }


@router.get("/{reference_id}", summary="Request detail")
async def get_request_detail(reference_id: str, user: Dict[str, Any] = Depends(require_ngo_worker)):
    doc = await _load(reference_id, user)
    return {"status": "success", "data": _present(doc, user)}


# --------------------------------------------------------------------------- decisions
@router.post("/{reference_id}/lines/{line_id}/approve", summary="Approve a pending line (starts the hold)")
async def approve_line(
    reference_id: str,
    line_id: str,
    body: Optional[NoteBody] = None,
    user: Dict[str, Any] = Depends(require_ngo_worker),
):
    doc = await _load(reference_id, user)
    line = _need_line(doc, line_id)
    uid = _uid(user)

    if not (_is_super(user) or _is_admin_of(user, line["ngoId"])):
        raise HTTPException(status_code=403, detail="Only the owning NGO's admin or a super admin can approve.")

    # 1. claim the line (atomic): a second click / second admin gets a 409 here
    if not await store.set_line_status(reference_id, line_id, [store.PENDING], store.PROCESSING):
        raise HTTPException(
            status_code=409,
            detail=f"Line is {line.get('status')}; only PENDING lines can be approved.",
        )

    # 2. start the hold in res_manage_svc (atomic there too)
    try:
        resp = await res_client.reserve_stock(
            inventory_id=line["inventoryId"],
            reference_id=reference_id,
            quantity=line["quantity"],
            reason=f"Approved by user {uid} for request {reference_id}",
            include_owner_reserve=True,  # approver is the owner (or super admin): may give away protected stock
            performed_by=uid,
        )
    except Exception:
        logger.exception(f"[requests] reserve call crashed for {reference_id}/{line_id}")
        await _revert(reference_id, line_id, store.PENDING)
        raise HTTPException(status_code=500, detail="Unexpected error while reserving stock.")

    if resp.get("status") != "success":
        if resp.get("ambiguous"):
            # outcome unknown (timeout / 5xx): make sure nothing stays held (result may legitimately be "no hold")
            await res_client.cancel_reservation(
                inventory_id=line["inventoryId"],
                reference_id=reference_id,
                quantity=line["quantity"],
                reason=f"Cleanup after unclear reserve for request {reference_id}",
                performed_by=uid,
            )
        await _revert(reference_id, line_id, store.PENDING)
        await invalidate_stock_cache([(line["resourceId"], line["warehouseName"])])
        raise _error_from(resp, "Could not reserve stock.")

    # 3. record the decision
    try:
        await store.set_line_status(
            reference_id,
            line_id,
            [store.PROCESSING],
            store.APPROVED,
            {
                "decidedAt": store.utcnow(),
                "decidedBy": uid,
                "note": body.note if body else None,
            },
        )
    except Exception:
        logger.exception(
            f"[requests] STOCK IS HELD but line update failed: ref={reference_id} line={line_id} "
            f"inventory={line['inventoryId']} qty={line['quantity']}"
        )
        raise HTTPException(
            status_code=500,
            detail="Stock was reserved but the request could not be updated. Contact an administrator.",
        )

    await invalidate_stock_cache([(line["resourceId"], line["warehouseName"])])
    return await _ok("Line approved and stock is on hold.", reference_id, user)


@router.post("/{reference_id}/lines/{line_id}/reject", summary="Reject a pending line (nothing is held)")
async def reject_line(
    reference_id: str,
    line_id: str,
    body: Optional[NoteBody] = None,
    user: Dict[str, Any] = Depends(require_ngo_worker),
):
    doc = await _load(reference_id, user)
    line = _need_line(doc, line_id)

    if not (_is_super(user) or _is_admin_of(user, line["ngoId"])):
        raise HTTPException(status_code=403, detail="Only the owning NGO's admin or a super admin can reject.")

    changed = await store.set_line_status(
        reference_id,
        line_id,
        [store.PENDING],
        store.REJECTED,
        {"decidedAt": store.utcnow(), "decidedBy": _uid(user), "note": body.note if body else None},
    )
    if not changed:
        raise HTTPException(
            status_code=409,
            detail=f"Line is {line.get('status')}; only PENDING lines can be rejected.",
        )
    return await _ok("Line rejected.", reference_id, user)


# --------------------------------------------------------------------------- cancel / dispatch
@router.post("/{reference_id}/lines/{line_id}/cancel", summary="Withdraw a pending line or release its hold")
async def cancel_line(
    reference_id: str,
    line_id: str,
    body: Optional[NoteBody] = None,
    user: Dict[str, Any] = Depends(require_ngo_worker),
):
    doc = await _load(reference_id, user)
    line = _need_line(doc, line_id)
    uid = _uid(user)

    allowed = (
        _is_super(user)
        or doc.get("requestedBy") == uid
        or _is_admin_of(user, doc.get("requesterNgoId", ""))
        or _is_admin_of(user, line["ngoId"])
    )
    if not allowed:
        raise HTTPException(status_code=403, detail="Not allowed to cancel this line.")

    current = line.get("status")
    extra = {"note": body.note} if body and body.note else None

    if current == store.PENDING:
        # nothing is held: just withdraw it
        if not await store.set_line_status(reference_id, line_id, [store.PENDING], store.CANCELLED, extra):
            raise HTTPException(status_code=409, detail="Line changed in the meantime; reload and try again.")
        return await _ok("Line cancelled.", reference_id, user)

    if current != store.APPROVED:
        raise HTTPException(status_code=409, detail=f"Line is {current}; it cannot be cancelled.")

    # APPROVED: a hold exists -> release it
    if not await store.set_line_status(reference_id, line_id, [store.APPROVED], store.PROCESSING):
        raise HTTPException(status_code=409, detail="Line changed in the meantime; reload and try again.")

    try:
        resp = await res_client.cancel_reservation(
            inventory_id=line["inventoryId"],
            reference_id=reference_id,
            quantity=line["quantity"],
            reason=f"Cancelled by user {uid}",
            performed_by=uid,
        )
    except Exception:
        logger.exception(f"[requests] cancel call crashed for {reference_id}/{line_id}")
        await _revert(reference_id, line_id, store.APPROVED)
        raise HTTPException(status_code=500, detail="Unexpected error while releasing stock.")

    # "no active hold" means there is nothing left to release (e.g. a hold that never got made): fine to cancel
    nothing_to_release = resp.get("statusCode") == 409 and "No active hold" in str(resp.get("message", ""))
    if resp.get("status") != "success" and not nothing_to_release:
        await _revert(reference_id, line_id, store.APPROVED)
        raise _error_from(resp, "Could not release the hold.")

    await store.set_line_status(reference_id, line_id, [store.PROCESSING], store.CANCELLED, extra)
    await invalidate_stock_cache([(line["resourceId"], line["warehouseName"])])
    return await _ok("Line cancelled and stock released.", reference_id, user)


@router.post("/{reference_id}/lines/{line_id}/dispatch", summary="Truck left: turn the hold into shipped stock")
async def dispatch_line(
    reference_id: str,
    line_id: str,
    body: Optional[NoteBody] = None,
    user: Dict[str, Any] = Depends(require_ngo_worker),
):
    doc = await _load(reference_id, user)
    line = _need_line(doc, line_id)
    uid = _uid(user)

    if not (_is_super(user) or _is_staff_of(user, line["ngoId"])):
        raise HTTPException(
            status_code=403, detail="Only the owning NGO's staff or a super admin can dispatch."
        )

    if not await store.set_line_status(reference_id, line_id, [store.APPROVED], store.PROCESSING):
        raise HTTPException(
            status_code=409,
            detail=f"Line is {line.get('status')}; only APPROVED lines can be dispatched.",
        )

    try:
        resp = await res_client.dispatch_stock(
            inventory_id=line["inventoryId"],
            reference_id=reference_id,
            quantity=line["quantity"],
            reason=(body.note if body and body.note else f"Dispatched by user {uid}"),
            performed_by=uid,
        )
    except Exception:
        logger.exception(f"[requests] dispatch call crashed for {reference_id}/{line_id}")
        await _revert(reference_id, line_id, store.APPROVED)
        raise HTTPException(status_code=500, detail="Unexpected error while dispatching.")

    if resp.get("status") != "success":
        await _revert(reference_id, line_id, store.APPROVED)
        if resp.get("ambiguous"):
            # we cannot tell whether the truck's stock was already booked out: do not guess
            logger.error(f"[requests] dispatch outcome UNKNOWN for {reference_id}/{line_id}: {resp.get('message')}")
            raise HTTPException(
                status_code=502,
                detail="Dispatch outcome unclear. Check the ledger for this referenceId before retrying.",
            )
        raise _error_from(resp, "Could not dispatch.")

    await store.set_line_status(reference_id, line_id, [store.PROCESSING], store.DISPATCHED)
    await invalidate_stock_cache([(line["resourceId"], line["warehouseName"])])
    return await _ok("Dispatched. Stock has left the warehouse.", reference_id, user)