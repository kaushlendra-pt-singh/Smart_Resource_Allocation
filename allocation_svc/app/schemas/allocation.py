from pydantic import BaseModel, Field, field_validator
from typing import List, Optional
from enum import Enum


class UrgencyLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class AllocationItemRequest(BaseModel):
    resourceId: str = Field(..., description="Mongoose ObjectId string of the resource")
    requestedQuantity: int = Field(..., gt=0, description="Quantity required (> 0)")
    preferredWarehouseName: Optional[str] = Field(
        None, description="Optional preferred warehouse name to check first"
    )


class AllocationRequest(BaseModel):
    requesterNgoId: str = Field(..., description="ID of the NGO making the request")
    items: List[AllocationItemRequest] = Field(
        ..., min_length=1, description="List of items to allocate"
    )
    targetLocation: Optional[List[float]] = Field(
        None,
        description="Target coordinates [longitude, latitude]. Required if preferred warehouse alone cannot fulfill request.",
    )
    maxSearchRadiusKm: float = Field(
        default=50.0, gt=0, le=500.0, description="Search radius in kilometers"
    )
    allowPartialFulfillment: bool = Field(
        default=True,
        description="Allow partial allocation if total requested stock is unavailable",
    )
    urgencyLevel: UrgencyLevel = Field(
        default=UrgencyLevel.MEDIUM, description="Urgency level of the allocation"
    )

    @field_validator("targetLocation")
    @classmethod
    def validate_coordinates(cls, v):
        if v is not None:
            if len(v) != 2:
                raise ValueError("targetLocation must be a [longitude, latitude] pair")
            lng, lat = v[0], v[1]
            if not (-180 <= lng <= 180):
                raise ValueError("Longitude must be between -180 and 180")
            if not (-90 <= lat <= 90):
                raise ValueError("Latitude must be between -90 and 90")
        return v


class WarehouseAllocationBreakdown(BaseModel):
    inventoryId: str
    warehouseName: str
    ngoId: str
    isOwnNgoWarehouse: bool
    allocatedQuantity: int
    distanceKm: float
    warehouseCoordinates: List[float]


class ItemAllocationResult(BaseModel):
    resourceId: str
    requestedQuantity: int
    totalAllocatedQuantity: int
    isFullyAllocated: bool
    allocations: List[WarehouseAllocationBreakdown]


class AllocationResponse(BaseModel):
    status: str = Field(..., description="success, partial_success, or failed")
    message: str
    requesterNgoId: str
    referenceId: str = Field(
        ..., description="Unique allocation reference transaction ID"
    )
    results: List[ItemAllocationResult]
