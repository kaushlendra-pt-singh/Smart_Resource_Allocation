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
from app.core.security import require_ngo_worker
from app.core.config import settings

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
    await invalidate_stock_cache([(h["resourceId"], h["warehouseName"]) for h in holds])
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
    user_id = current_user.get("_id") or current_user.get("userId")
    user_role = current_user.get("role", "USER")
    requester_ngo_id = current_user.get("ngoId", "")

    reference_id = f"ALLOC-{uuid.uuid4().hex[:8].upper()}"
    logger.info(f"[allocation] User {user_id} requested allocation ref: {reference_id} for NGO: {requester_ngo_id}")

    # Strict mode = all-or-nothing: every item must be fully reserved, else everything is released.
    strict = not request.allowPartialFulfillment
    rollback_reason = f"Rollback of allocation ref: {reference_id}"

    holds: List[Dict[str, Any]] = []  # every CONFIRMED reservation made in this request
    item_results: List[ItemAllocationResult] = []
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
                user_role=user_role,
                allow_partial_fulfillment=request.allowPartialFulfillment,
            )

            reserved_breakdowns: List[WarehouseAllocationBreakdown] = []

            # 3. Reserve allocated stock
            for alloc in opt_result.allocations:
                qty_to_reserve = alloc["allocatedQuantity"]
                inventory_id = alloc["inventoryId"]

                reserve_resp = await res_client.reserve_stock(
                    inventory_id=inventory_id,
                    quantity=qty_to_reserve,
                    reference_id=reference_id,
                    reason=f"Disaster hold ref: {reference_id} by user: {user_id}",
                    include_owner_reserve=has_owner_tier(alloc["ngoId"], requester_ngo_id, user_role),
                )

                if reserve_resp.get("status") == "success":
                    holds.append(
                        {
                            "inventoryId": inventory_id,
                            "warehouseName": alloc["warehouseName"],
                            "resourceId": item.resourceId,
                            "quantity": qty_to_reserve,
                        }
                    )
                    reserved_breakdowns.append(
                        WarehouseAllocationBreakdown(
                            inventoryId=inventory_id,
                            warehouseName=alloc["warehouseName"],
                            ngoId=alloc["ngoId"],
                            isOwnNgoWarehouse=alloc["isOwnNgoWarehouse"],
                            allocatedQuantity=qty_to_reserve,
                            distanceKm=alloc["distanceKm"],
                            warehouseCoordinates=alloc["warehouseCoordinates"],
                        )
                    )
                else:
                    logger.error(
                        f"[allocation] Reservation failed for inventory {inventory_id}: "
                        f"{reserve_resp.get('message')}"
                    )
                    has_failure = True
                    if reserve_resp.get("ambiguous"):
                        # Outcome unknown (timeout / 5xx): make sure nothing stays held.
                        # Result intentionally ignored - cancel may legitimately fail if
                        # the reservation never happened.
                        await res_client.cancel_reservation(
                            inventory_id=inventory_id,
                            reference_id=reference_id,
                            quantity=qty_to_reserve,
                            reason=rollback_reason,
                        )
                        await invalidate_stock_cache([(item.resourceId, alloc["warehouseName"])])

            total_held = sum(b.allocatedQuantity for b in reserved_breakdowns)
            is_fully = total_held >= item.requestedQuantity
            if not is_fully:
                has_partial = True

            item_results.append(
                ItemAllocationResult(
                    resourceId=item.resourceId,
                    requestedQuantity=item.requestedQuantity,
                    totalAllocatedQuantity=total_held,
                    isFullyAllocated=is_fully,
                    allocations=reserved_breakdowns,
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
        await invalidate_stock_cache([(h["resourceId"], h["warehouseName"]) for h in holds])

        total_allocated_all = sum(r.totalAllocatedQuantity for r in item_results)
        if total_allocated_all == 0:
            overall_status = "failed"
            msg = (
                "Allocation failed due to stock reservation conflicts or service unavailability."
                if has_failure
                else "No stock available to satisfy the request."
            )
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