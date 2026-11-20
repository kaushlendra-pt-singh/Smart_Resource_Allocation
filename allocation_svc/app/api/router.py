from fastapi import APIRouter
from app.api.endpoints import allocation
from app.api.endpoints import health
from app.api.endpoints import requests

api_v1_router = APIRouter()

# Public endpoint: /api/v1/health (No auth required for health probes)
api_v1_router.include_router(
    health.router,
    prefix="/health",
    tags=["Health"]
)

# Protected endpoint: /api/v1/allocate (JWT Bearer + NGO_WORKER / ADMIN role required)
api_v1_router.include_router(
    allocation.router, 
    tags=["Allocation"]
)

# Protected endpoints: /api/v1/requests (Allocation request tracking & line approval)
api_v1_router.include_router(
    requests.router,
    prefix="/requests",
    tags=["Requests"]
)