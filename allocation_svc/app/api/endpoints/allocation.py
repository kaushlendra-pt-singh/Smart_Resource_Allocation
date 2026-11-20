import asyncio
import uuid
import logging
from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status

from app.schemas.allocation import (
    AllocationRequest,
    AllocationResponse,
    ItemAllocationResult,
    WarehouseAllocationBreakdown,
)
from app.services.optimizer import (
    fetch_candidate_warehouses,
    has_owner_tier,
    invalidate_stock_cache,
    optimizer,
)
from app.services.res_client import res_client
from app.services import request_store as store
from app.core.security import require_ngo_worker
from app.core.config import settings
from app.core import access

logger = logging.getLogger(settings.APP_NAME)
router = APIRouter()


async def _release_holds(holds: List[Dict[str, Any]], reference_id: str, reason: str) -> List[str]:
    """
    Best-effort rollback of confirmed reservations.
    Returns the inventory ids that could NOT be released (need manual reconciliation).
    """
    if not holds:
        return []

    results = await asyncio.gather(
        *[
            res_client.cancel_reservation(
                inventory_id=h["inventoryId"],
                reference_id=reference_id,
                quantity=h["quantity"],
                reason=reason,
            )
            for h in holds
        ],
        return_exceptions=True,
    )

    failed: List[str] = []
    for h, r in zip(holds, results):
        if isinstance(r, BaseException) or r.get("status") != "success":
            failed.append(h["inventoryId"])
            logger.error(
                f"[allocation] ROLLBACK FAILED ref={reference_id} inventory={h['inventoryId']} "
                f"qty={h['quantity']} result={r!r}"
            )

    # Stock changed -> drop cached stock so the next request re-reads fresh data.
    await invalidate_stock_cache([h["inventoryId"] for h in holds])
    return failed


@router.post(
    "/allocate",
    response_model=AllocationResponse,
    status_code=status.HTTP_200_OK,
    summary="Execute disaster resource allocation optimization",
)
async def allocate_resources(
    request: AllocationRequest,
    current_user: Dict[str, Any] = Depends(require_ngo_worker)
):
    user_id = access.uid(current_user)
    user_role = access.role(current_user)

    # Which NGO is asking: explicit requesterNgoId, else the NGO the user owns, else their only NGO.
    # The user must be admin/worker of that NGO (super admin may act for any NGO, or for none).
    my_ngos = access.staff_ngo_ids(current_user)
    owned = access.owned_ngo(current_user)
    requester_ngo_id = (
        request.requesterNgoId
        or (owned if owned in my_ngos else "")
        or (next(iter(my_ngos)) if len(my_ngos) == 1 else "")
    )
    if not access.is_super(current_user):
        if not requester_ngo_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="requesterNgoId is required (you are a member of several NGOs, or of none).",
            )
        if not access.is_staff_of(current_user, requester_ngo_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can only request allocations for an NGO you are an admin or worker of.",
            )

    reference_id = f"ALLOC-{uuid.uuid4().hex[:8].upper()}"
    logger.info(f"[allocation] User {user_id} requested allocation ref: {reference_id} for NGO: {requester_ngo_id}")

    # Strict mode = all-or-nothing: every item must be fully reserved/planned, else everything is released.
    strict = not request.allowPartialFulfillment
    rollback_reason = f"Rollback of allocation ref: {reference_id}"

    holds: List[Dict[str, Any]] = []  # every CONFIRMED reservation made in this request
    item_results: List[ItemAllocationResult] = []
    all_saved_lines: List[Dict[str, Any]] = []
    has_partial = False
    has_failure = False

    try:
        for item in request.items:
            # 1. Fetch candidate warehouses
            candidates = await fetch_candidate_warehouses(
                resource_id=item.resourceId,
                target_location=request.targetLocation,
                radius_km=request.maxSearchRadiusKm,
                user_role=user_role,
            )

            # 2. Run spatial optimizer
            opt_result = optimizer.solve_single_resource_allocation(
                resource_id=item.resourceId,
                requested_quantity=item.requestedQuantity,
                requesting_ngo_id=requester_ngo_id,
                target_location=request.targetLocation,
                candidates=candidates,
                preferred_warehouse_name=item.preferredWarehouseName,
                user=current_user,
                allow_partial_fulfillment=request.allowPartialFulfillment,
            )

            breakdowns: List[WarehouseAllocationBreakdown] = []

            # 3. Process allocated stock per warehouse
            for alloc in opt_result.allocations:
                qty = alloc["allocatedQuantity"]
                inventory_id = alloc["inventoryId"]
                warehouse_ngo_id = alloc["ngoId"]
                is_own_wh = alloc["isOwnNgoWarehouse"]

                # Own NGO warehouse or Super Admin -> auto-approve and hold immediately.
                # External NGO warehouse -> PENDING approval from the owning NGO (nothing held yet).
                auto_approve = is_own_wh or user_role == "SUPER_ADMIN"

                if auto_approve:
                    reserve_resp = await res_client.reserve_stock(
                        inventory_id=inventory_id,
                        quantity=qty,
                        reference_id=reference_id,
                        reason=f"Disaster hold ref: {reference_id} by user: {user_id}",
                        include_owner_reserve=has_owner_tier(warehouse_ngo_id, current_user),
                    )

                    if reserve_resp.get("status") == "success":
                        holds.append(
                            {
                                "inventoryId": inventory_id,
                                "warehouseName": alloc["warehouseName"],
                                "resourceId": item.resourceId,
                                "quantity": qty,
                            }
                        )
                        line_dict = store.new_line(
                            resource_id=item.resourceId,
                            inventory_id=inventory_id,
                            warehouse_name=alloc["warehouseName"],
                            ngo_id=warehouse_ngo_id,
                            quantity=qty,
                            distance_km=alloc["distanceKm"],
                            coordinates=alloc["warehouseCoordinates"],
                            status=store.APPROVED,
                        )
                        line_dict["decidedAt"] = store.utcnow()
                        line_dict["decidedBy"] = str(user_id)
                        line_dict["note"] = "Auto-approved own warehouse allocation"
                        all_saved_lines.append(line_dict)

                        breakdowns.append(
                            WarehouseAllocationBreakdown(
                                inventoryId=inventory_id,
                                warehouseName=alloc["warehouseName"],
                                ngoId=warehouse_ngo_id,
                                isOwnNgoWarehouse=is_own_wh,
                                allocatedQuantity=qty,
                                distanceKm=alloc["distanceKm"],
                                warehouseCoordinates=alloc["warehouseCoordinates"],
                                lineId=line_dict["lineId"],
                                lineStatus=store.APPROVED,
                            )
                        )
                    else:
                        logger.error(
                            f"[allocation] Reservation failed for inventory {inventory_id}: "
                            f"{reserve_resp.get('message')}"
                        )
                        has_failure = True
                        if reserve_resp.get("ambiguous"):
                            await res_client.cancel_reservation(
                                inventory_id=inventory_id,
                                reference_id=reference_id,
                                quantity=qty,
                                reason=rollback_reason,
                            )
                            await invalidate_stock_cache([inventory_id])
                else:
                    # External NGO warehouse: plan created as PENDING, waiting for owner NGO approval
                    line_dict = store.new_line(
                        resource_id=item.resourceId,
                        inventory_id=inventory_id,
                        warehouse_name=alloc["warehouseName"],
                        ngo_id=warehouse_ngo_id,
                        quantity=qty,
                        distance_km=alloc["distanceKm"],
                        coordinates=alloc["warehouseCoordinates"],
                        status=store.PENDING,
                    )
                    all_saved_lines.append(line_dict)

                    breakdowns.append(
                        WarehouseAllocationBreakdown(
                            inventoryId=inventory_id,
                            warehouseName=alloc["warehouseName"],
                            ngoId=warehouse_ngo_id,
                            isOwnNgoWarehouse=is_own_wh,
                            allocatedQuantity=qty,
                            distanceKm=alloc["distanceKm"],
                            warehouseCoordinates=alloc["warehouseCoordinates"],
                            lineId=line_dict["lineId"],
                            lineStatus=store.PENDING,
                        )
                    )

            held_qty = sum(b.allocatedQuantity for b in breakdowns if b.lineStatus == store.APPROVED)
            pending_qty = sum(b.allocatedQuantity for b in breakdowns if b.lineStatus == store.PENDING)
            total_allocated = held_qty + pending_qty
            is_fully = total_allocated >= item.requestedQuantity

            if not is_fully:
                has_partial = True

            item_results.append(
                ItemAllocationResult(
                    resourceId=item.resourceId,
                    requestedQuantity=item.requestedQuantity,
                    totalAllocatedQuantity=total_allocated,
                    isFullyAllocated=is_fully,
                    heldQuantity=held_qty,
                    pendingQuantity=pending_qty,
                    allocations=breakdowns,
                )
            )

            # All-or-nothing: no point reserving further items once one item fell short.
            if strict and not is_fully:
                break

    except Exception:
        logger.exception(f"[allocation] Unexpected error, rolling back ref: {reference_id}")
        await _release_holds(holds, reference_id, rollback_reason)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Allocation failed unexpectedly; held stock was released. Reference: {reference_id}",
        )

    rollback_note = ""

    # Strict mode and anything fell short -> release EVERYTHING and report zero allocation.
    if strict and (has_partial or has_failure):
        failed_release = await _release_holds(holds, reference_id, rollback_reason)
        item_results = [
            ItemAllocationResult(
                resourceId=i.resourceId,
                requestedQuantity=i.requestedQuantity,
                totalAllocatedQuantity=0,
                isFullyAllocated=False,
                heldQuantity=0,
                pendingQuantity=0,
                allocations=[],
            )
            for i in request.items
        ]
        if failed_release:
            rollback_note = (
                f" WARNING: could not release holds on inventories {failed_release}; "
                f"reference {reference_id} needs manual reconciliation."
            )
        overall_status = "failed"
        msg = (
            "Allocation could not be completed in full; all holds were released."
            if not has_failure
            else "Allocation failed due to stock reservation conflicts or service unavailability; all holds were released."
        ) + rollback_note
    else:
        # Reservations that stand changed stock -> refresh cache on next read.
        if holds:
            await invalidate_stock_cache([h["inventoryId"] for h in holds])

        total_allocated_all = sum(r.totalAllocatedQuantity for r in item_results)
        total_held_all = sum(r.heldQuantity for r in item_results)
        total_pending_all = sum(r.pendingQuantity for r in item_results)

        if total_allocated_all == 0:
            overall_status = "failed"
            msg = (
                "Allocation failed due to stock reservation conflicts or service unavailability."
                if has_failure
                else "No stock available to satisfy the request."
            )
        else:
            # Persist allocation request to MongoDB allocation_requests collection
            if all_saved_lines:
                req_doc = {
                    "referenceId": reference_id,
                    "requesterNgoId": requester_ngo_id,
                    "requestedBy": str(user_id),
                    "requesterRole": user_role,
                    "createdAt": store.utcnow(),
                    "items": [
                        {"resourceId": it.resourceId, "requestedQuantity": it.requestedQuantity}
                        for it in request.items
                    ],
                    "lines": all_saved_lines,
                }
                await store.create_request(req_doc)

            if total_pending_all > 0 and total_held_all == 0:
                overall_status = "pending_approval"
                msg = "Allocation request created and awaiting approval from owning NGO(s)."
            elif total_pending_all > 0 and total_held_all > 0:
                overall_status = "partial_success"
                msg = "Own resources reserved; external allocations are pending approval from owning NGO(s)."
            elif has_partial or has_failure:
                overall_status = "partial_success"
                msg = "Partial allocation completed. Some requested items could not be fully satisfied."
            else:
                overall_status = "success"
                msg = "Successfully allocated and reserved requested resources."

    return AllocationResponse(
        status=overall_status,
        message=msg,
        requesterNgoId=requester_ngo_id,
        referenceId=reference_id,
        results=item_results,
    )
