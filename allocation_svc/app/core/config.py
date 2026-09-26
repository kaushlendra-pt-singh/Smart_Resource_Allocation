from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    APP_NAME: str = "allocation_svc"
    PORT: int = 8003
    LOG_LEVEL: str = "info"

    # Inter-Service Security
    INTERNAL_API_KEY: str = "dev_shared_internal_secret_key_123"
    JWT_ACCESS_SECRET: str = "your_node_jwt_access_secret_here"

    # Service Connections
    MONGODB_URI: str = "mongodb://localhost:27017/res_manage_db"
    RES_MANAGE_SVC_URL: str = "http://localhost:8002"
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_PASSWORD: str = ""
    REDIS_DB: int = 0

    model_config = SettingsConfigDict(env_file="../../.env", extra="ignore")

settings = Settings()