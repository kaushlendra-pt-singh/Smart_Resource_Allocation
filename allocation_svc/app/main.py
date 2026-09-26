import logging
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.db import connect_to_mongo, close_mongo_connection
from app.core.redis import check_redis_health
from app.api.router import api_v1_router
from app.api.endpoints.health import health_check

logging.basicConfig(level=settings.LOG_LEVEL.upper())
logger = logging.getLogger(settings.APP_NAME)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Starting {settings.APP_NAME}...")
    await connect_to_mongo()
    redis_healthy = await check_redis_health()
    if redis_healthy:
        logger.info("[redis] Connected successfully to Redis.")
    else:
        logger.warning("[redis] Could not reach Redis on startup. Relying on MongoDB fallback.")
    
    yield

    logger.info(f"Shutting down {settings.APP_NAME}...")
    await close_mongo_connection()


app = FastAPI(
    title="Disaster Relief Resource Allocation Service",
    description="High-performance spatial optimization service for automated resource allocation.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/", tags=["Root"])
def root():
    return {
        "status": "Allocation Service up.",
        "message": "Server is running.",
        "time_stamp": datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    }

@app.get("/health", tags=["Health"])
async def root_health():
    return await health_check()

# Mount all API V1 routes cleanly through api_v1_router
app.include_router(api_v1_router, prefix="/allocation/api")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=settings.PORT, env_file="../.env", reload=True)