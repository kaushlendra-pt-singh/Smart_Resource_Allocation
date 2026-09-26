import sys
import uvicorn
from app.core.config import settings


def main():
    """
    Application entrypoint that loads environment variables via Pydantic Settings
    before passing configuration directly to Uvicorn.
    """
    # Determine auto-reload mode based on configuration/environment
    is_development = getattr(settings, "NODE_ENV", "development").lower() == "development"

    print(f"🚀 Initializing {settings.APP_NAME} on http://0.0.0.0:{settings.PORT}")

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.PORT,               # Reads PORT (8003) from .env via Pydantic Settings
        reload=is_development,            # Enable hot-reload during local development
        log_level=settings.LOG_LEVEL.lower(),
        env_file=".env",                  # Ensures sub-processes/workers inherit .env
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n👋 Service stopped gracefully.")
        sys.exit(0)