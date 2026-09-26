import logging
from typing import Dict, Any
from fastapi import APIRouter, status

from app.core.config import settings
from app.core.redis import check_redis_health
from app.core.db import mongo_db

logger = logging.getLogger(settings.APP_NAME)
router = APIRouter()


def ping() -> Dict[str, str]:
    """Lightweight alive check returning standard status payload."""
    return {
        "status": "Allocation Service up.",
        "message": "Server is running."
    }


async def health_check() -> Dict[str, Any]:
    """Deep health check inspecting MongoDB and Redis connectivity."""
    redis_status = await check_redis_health()
    
    mongo_status = False
    if mongo_db.client is not None:
        try:
            await mongo_db.client.admin.command("ping")
            mongo_status = True
        except Exception as e:
            logger.error(f"[health] MongoDB ping failed: {e}")

    overall_healthy = redis_status and mongo_status

    return {
        "service": settings.APP_NAME,
        "status": "healthy" if overall_healthy else "degraded",
        "connections": {
            "redis": "connected" if redis_status else "unreachable",
            "mongodb": "connected" if mongo_status else "unreachable",
        },
        "version": "1.0.0"
    }


# Route for /api/v1/health
@router.get("", status_code=status.HTTP_200_OK, summary="API v1 Health check")
async def api_health():
    return await health_check()