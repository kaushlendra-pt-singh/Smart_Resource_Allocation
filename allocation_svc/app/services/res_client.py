import logging
from typing import Dict, Any, Optional
import httpx
from app.core.config import settings

logger = logging.getLogger(settings.APP_NAME)

_FAILURE_STATUSES = {"failed", "fail", "error", "false"}


class ResServiceClient:
    """
    Async HTTP Client for inter-service communication with res_manage_svc.
    Uses x-internal-key authentication header to call internal endpoints.

    Every method returns a NORMALIZED dict:
      success -> {"status": "success", ...body of res_manage_svc...}
      failure -> {"status": "failed", "statusCode"?, "message", "data"?, "ambiguous": bool}

    "ambiguous" = True means the request may have been processed by
    res_manage_svc even though we did not get a clean answer (read timeout,
    connection dropped, 5xx). Callers must then make sure nothing is left held.
    """

    def __init__(self):
        self.base_url = settings.RES_MANAGE_SVC_URL.rstrip("/")
        self.headers = {
            "Content-Type": "application/json",
            "x-internal-key": settings.INTERNAL_API_KEY,
        }
        # Timeout settings: 5s connection, 10s read
        self.timeout = httpx.Timeout(10.0, connect=5.0)

    @staticmethod
    def _body_signals_success(body: Any) -> bool:
        """A 2xx is a success unless the body explicitly says otherwise."""
        if not isinstance(body, dict):
            return True
        if body.get("success") is False:
            return False
        status_val = body.get("status")
        if isinstance(status_val, str) and status_val.lower() in _FAILURE_STATUSES:
            return False
        return True

    async def _post(
        self, path: str, payload: Dict[str, Any], action: str, default_error: str
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(
                headers=self.headers, timeout=self.timeout
            ) as client:
                response = await client.post(url, json=payload)

        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
            # Request never reached res_manage_svc -> definitely not processed.
            logger.error(f"[res_client] {action}: cannot connect: {exc!r}")
            return {
                "status": "failed",
                "message": f"Unable to reach res_manage_svc: {exc!r}",
                "ambiguous": False,
            }
        except httpx.RequestError as exc:
            # Read/write timeout, dropped connection, etc. -> outcome unknown.
            logger.error(
                f"[res_client] {action}: request error (outcome unknown): {exc!r}"
            )
            return {
                "status": "failed",
                "message": f"No clean response from res_manage_svc: {exc!r}",
                "ambiguous": True,
            }

        try:
            body = response.json()
        except ValueError:
            body = None

        if 200 <= response.status_code < 300 and self._body_signals_success(body):
            result: Dict[str, Any] = (
                dict(body) if isinstance(body, dict) else {"data": body}
            )
            result["status"] = "success"  # normalize regardless of upstream shape
            return result

        message = (
            (body.get("message") if isinstance(body, dict) else None)
            or response.text
            or default_error
        )
        logger.error(
            f"[res_client] {action} failed. Status: {response.status_code}, Body: {response.text}"
        )
        return {
            "status": "failed",
            "statusCode": response.status_code,
            "message": message,
            "data": body,
            # 5xx: the server may have applied the change before erroring.
            "ambiguous": response.status_code >= 500,
        }

    async def reserve_stock(
        self,
        inventory_id: str,
        reference_id: str,
        quantity: int,
        reason: Optional[str] = None,
        include_owner_reserve: bool = False,
        performed_by: Optional[str] = "allocation_svc",
    ) -> Dict[str, Any]:
        """POST /api/internal/inventory/reserve"""
        return await self._post(
            "/api/internal/inventory/reserve",
            {
                "inventoryId": inventory_id,
                "referenceId": reference_id,
                "quantity": quantity,
                "performedBy": performed_by,
                "includeOwnerReserve": include_owner_reserve,
                "notes": reason
                or "Automated disaster allocation hold by allocation_svc",
            },
            action="reserve",
            default_error="Failed to reserve stock in res_manage_svc.",
        )

    async def cancel_reservation(
        self,
        inventory_id: str,
        reference_id: str,
        quantity: int,
        performed_by: Optional[str] = "allocation_svc",
        reason: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /api/internal/inventory/cancel-reservation"""
        return await self._post(
            "/api/internal/inventory/cancel-reservation",
            {
                "inventoryId": inventory_id,
                "referenceId": reference_id,
                "quantity": quantity,
                "performedBy": performed_by,
                "notes": reason
                or "Automated hold timeout or rollback by allocation_svc",
            },
            action="cancel-reservation",
            default_error="Failed to cancel reservation in res_manage_svc.",
        )

    async def dispatch_stock(
        self,
        inventory_id: str,
        reference_id: str,
        quantity: int,
        reason: Optional[str] = None,
        performed_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /api/internal/inventory/dispatch - turns a held reservation into shipped stock."""
        return await self._post(
            "/api/internal/inventory/dispatch",
            {
                "inventoryId": inventory_id,
                "referenceId": reference_id,
                "quantity": quantity,
                "performedBy": performed_by or "allocation_svc",
                "notes": reason or "Held stock dispatched by allocation_svc",
            },
            action="dispatch",
            default_error="Failed to dispatch held stock in res_manage_svc.",
        )


# Export a singleton instance
res_client = ResServiceClient()
