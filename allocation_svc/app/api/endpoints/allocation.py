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
from app.services.optimizer import fetch_candidate_warehouses, optimizer
from app.services.res_client import res_client
from app.core.security import require_ngo_worker
from app.core.config import settings

logger = logging.getLogger(settings.APP_NAME)
router = APIRouter()


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
    logger.info(f"[allocation] current_user = {current_user}")
    user_id = current_user.get("_id") or current_user.get("userId")
    # Default to token's ngoId if requesterNgoId is omitted in request body
    requester_ngo_id = current_user.get("ngoId", "")

    reference_id = f"ALLOC-{uuid.uuid4().hex[:8].upper()}"
    logger.info(f"[allocation] User {user_id} requested allocation ref: {reference_id} for NGO: {requester_ngo_id}")

    item_results: List[ItemAllocationResult] = []
    has_partial = False
    has_failure = False

    for item in request.items:
        # 1. Fetch candidate warehouses
        candidates = await fetch_candidate_warehouses(
            resource_id=item.resourceId,
            target_location=request.targetLocation,
            radius_km=request.maxSearchRadiusKm,
            user_role=current_user.get("role", "USER")
        )

        logger.info(
            f"[allocation] Found {len(candidates)} candidates "
            f"for resource={item.resourceId}"
        )

        for candidate in candidates:
            logger.info(
                f"A candidate is: {candidate}"
            )

        # 2. Run spatial optimizer
        opt_result = optimizer.solve_single_resource_allocation(
            resource_id=item.resourceId,
            requested_quantity=item.requestedQuantity,
            requesting_ngo_id=requester_ngo_id,
            target_location=request.targetLocation,
            candidates=candidates,
            preferred_warehouse_name=item.preferredWarehouseName,
            user_role=current_user["role"],
            allow_partial_fulfillment = request.allowPartialFulfillment
        )

        reserved_breakdowns: List[WarehouseAllocationBreakdown] = []

        # 3. Reserve allocated stock via inter-service HTTP client (res_client handles x-internal-key)
        for alloc in opt_result.allocations:
            qty_to_reserve = alloc["allocatedQuantity"]
            inventory_id = alloc["inventoryId"]

            reserve_resp = await res_client.reserve_stock(
                inventory_id=inventory_id,
                quantity=qty_to_reserve,
                reference_id=reference_id,
                reason=f"Disaster hold ref: {reference_id} by user: {user_id}",
            )

            if reserve_resp.get("status") == "success":
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
                logger.error(f"[allocation] Reservation failed for inventory {inventory_id}")
                has_failure = True

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

    if has_failure and not any(r.totalAllocatedQuantity > 0 for r in item_results):
        overall_status = "failed"
        msg = "Allocation failed due to stock reservation conflicts or service unavailability."
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

