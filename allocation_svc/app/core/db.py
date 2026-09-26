from typing import Optional
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
import logging
from app.core.config import settings

logger = logging.getLogger(settings.APP_NAME)

class MongoManager:
    client: Optional[AsyncIOMotorClient] = None
    db: Optional[AsyncIOMotorDatabase] = None

mongo_db = MongoManager()

async def connect_to_mongo() -> None:
    try:
        client = AsyncIOMotorClient(settings.MONGODB_URI)
        mongo_db.client = client
        mongo_db.db = client.get_database()
        await client.admin.command('ping')
        logger.info("[db] Connected successfully to MongoDB.")
    except Exception as e:
        logger.error(f"[db] Could not connect to MongoDB: {e}")
        raise e

async def close_mongo_connection() -> None:
    if mongo_db.client:
        mongo_db.client.close()
        logger.info("[db] MongoDB connection closed.")