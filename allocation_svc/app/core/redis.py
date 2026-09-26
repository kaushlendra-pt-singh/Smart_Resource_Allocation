import logging
import redis.asyncio as redis
from redis.asyncio.retry import Retry
from redis.backoff import ExponentialBackoff

from app.core.config import settings

logger = logging.getLogger(settings.APP_NAME)

# Define exponential backoff retry strategy (e.g. 10 retries)
# backoff=ExponentialBackoff(cap=3, base=0.5) caps delay at 3s, starting around 500ms
redis_retry = Retry(
    backoff=ExponentialBackoff(cap=3.0, base=0.5),
    retries=10
)

redis_client: redis.Redis = redis.Redis(
    host=settings.REDIS_HOST,
    port=settings.REDIS_PORT,
    password=settings.REDIS_PASSWORD or None,
    db=settings.REDIS_DB,
    decode_responses=True,
    # Retry & Timeout Configuration
    retry=redis_retry,
    retry_on_timeout=True,
    socket_timeout=3.0,         # 3s timeout for network reads/writes
    socket_connect_timeout=3.0, # 3s timeout when initially connecting
    health_check_interval=30    # Periodically ping background connection pool
)


async def check_redis_health() -> bool:
    """
    Pings Redis to check connectivity without crashing if offline.
    """
    try:
        return await redis_client.ping()
    except Exception as e:
        logger.error(f"❌ Redis health check failed: {e}. Operating in DB-only mode.")
        return False