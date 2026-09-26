import logging
from typing import Dict, Any, Optional
from fastapi import Security, HTTPException, status, Header, Cookie
from fastapi.security import APIKeyHeader, HTTPBearer, HTTPAuthorizationCredentials
from jwt import decode, ExpiredSignatureError, PyJWTError
from pydantic import BaseModel
from app.core.config import settings

class JWTUser(BaseModel):
    _id: str
    email: str
    role: str
    ngoId: str | None = None

logger = logging.getLogger(settings.APP_NAME)

# Security schemes for OpenAPI Swagger UI auto-documentation
internal_key_header = APIKeyHeader(name="x-internal-key", auto_error=False)
bearer_scheme = HTTPBearer(auto_error=False)


async def verify_internal_key(
    x_internal_key: Optional[str] = Security(internal_key_header)
) -> str:
    """
    Dependency to validate inter-service requests via x-internal-key header.
    Used on internal system endpoints accessed by other microservices.
    """
    if not x_internal_key or x_internal_key != settings.INTERNAL_API_KEY:
        logger.warning(f"[security] Invalid or missing internal API key: {x_internal_key}")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: Invalid or missing x-internal-key header."
        )
    return x_internal_key


async def verify_jwt_token(
    authorization: Optional[str] = Header(default=None),
    access_token: Optional[str] = Cookie(default=None),
):
    token = None

    # 1. Prefer Authorization header
    if authorization:
        parts = authorization.split(" ")

        if len(parts) == 2 and parts[0].lower() == "bearer":
            token = parts[1]

    # 2. Fall back to cookie
    if not token and access_token:
        token = access_token

    # 3. Nothing found
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 4. Verify JWT
    try:
        payload = decode(
            token,
            settings.JWT_ACCESS_SECRET,
            algorithms=["HS256"],
        )

        logger.info(f"[allocation] payload = {payload}")

        return payload

    except ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    except PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def require_ngo_worker(
    token_payload: Dict[str, Any] = Security(verify_jwt_token)
) -> Dict[str, Any]:
    """
    Enforces that the authenticated user possesses NGO_WORKER or ADMIN role.
    """
    role = token_payload.get("role", "").upper()
    if role not in ["NGO_WORKER", "NGO_ADMIN", "SUPER_ADMIN"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Operation requires NGO_WORKER or ADMIN role permissions."
        )
    return token_payload

