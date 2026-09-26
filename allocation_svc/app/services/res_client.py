import logging
from typing import Dict, Any, Optional
import httpx
from app.core.config import settings

logger = logging.getLogger(settings.APP_NAME)


class ResServiceClient:
    """
    Async HTTP Client for inter-service communication with res_manage_svc.
    Uses x-internal-key authentication header to call internal endpoints.
    """

    def __init__(self):
        self.base_url = settings.RES_MANAGE_SVC_URL.rstrip("/")
        self.headers = {
            "Content-Type": "application/json",
            "x-internal-key": settings.INTERNAL_API_KEY,
        }
        # Timeout settings: 5s connection, 10s read
        self.timeout = httpx.Timeout(10.0, connect=5.0)

    async def reserve_stock(
        self, inventory_id: str, reference_id: str, quantity: int, reason: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Calls res_manage_svc's internal reserve endpoint to hold stock.

        POST /api/internal/inventory
        Payload: { inventoryId, quantity, reason }
        """
        url = f"{self.base_url}/api/internal/inventory/reserve"
        payload = {
            "inventoryId": inventory_id,
            "referenceId": reference_id,
            "quantity": quantity,
            "notes": reason or "Automated disaster allocation hold by allocation_svc",
        }

        async with httpx.AsyncClient(
            headers=self.headers, timeout=self.timeout
        ) as client:
            try:
                data = None
                response = await client.post(url, json=payload)

                if response.status_code < 400:
                    return response.json()

                try:
                    data = response.json()
                    err_message = data.get(
                        "message",
                        "Failed to reserve stock in res_manage_svc."
                    )
                except Exception as e:
                    logger.error(f"Error in destructuring response in res_client: {e}")
                    err_message = response.text or "Failed to reserve stock in res_manage_svc."

                logger.error(
                    f"[res_client] Reserve failed. Status: {response.status_code}, Response: {response}"
                )
                return {
                    "status": "failed",
                    "statusCode": response.status_code,
                    "message": err_message,
                    "data": data
                }
            except httpx.RequestError as exc:
                logger.error(
                    f"[res_client] HTTP Request Exception while calling reserve: {exc}"
                )
                return {
                    "status": "failed",
                    "message": f"Unable to reach res_manage_svc: {str(exc)}",
                }

    async def cancel_reservation(
        self, inventory_id: str, reference_id: str, quantity: int, reason: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Calls res_manage_svc's internal cancel reservation endpoint to release a hold.

        POST /api/inventory/cancel-reservation
        Payload: { inventoryId, quantity, reason }
        """
        url = f"{self.base_url}/api/internal/inventory/cancel-reservation"
        payload = {
            "inventoryId": inventory_id,
            "referenceId": reference_id,
            "quantity": quantity,
            "notes": reason or "Automated hold timeout or rollback by allocation_svc",
        }

        async with httpx.AsyncClient(
            headers=self.headers, timeout=self.timeout
        ) as client:
            try:
                data = None
                response = await client.post(url, json=payload)

                if response.status_code < 400:
                    return response.json()

                logger.error(
                    f"[res_client] Cancel reservation failed. Status: {response.status_code}, Body: {response.text}"
                )

                try:
                    data = response.json()
                    err_message = data.get(
                        "message",
                        "Failed to reserve stock in res_manage_svc."
                    )
                except Exception as e:
                    logger.error(f"Error in destructuring response in res_client: {e}")
                    err_message = response.text or "Failed to reserve stock in res_manage_svc."

                return {
                    "status": "failed",
                    "statusCode": response.status_code,
                    "message": err_message,
                    "data": data
                }
            except httpx.RequestError as exc:
                logger.error(
                    f"[res_client] HTTP Request Exception while calling cancel-reservation: {exc}"
                )
                return {
                    "status": "failed",
                    "message": f"Unable to reach res_manage_svc: {str(exc)}",
                }


# Export a singleton instance
res_client = ResServiceClient()
