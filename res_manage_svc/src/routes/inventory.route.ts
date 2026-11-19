import express from "express";
import { authMiddleWare, requireRoles } from "../middlewares/auth.middleware";
import rateLimiter from "../middlewares/rateLimiter";
import {
    dispatchInventory,
    getInventoryByLocation,
    getInventoryLedger,
    restockInventory
} from "../controllers/inventory.controller";

import { setOwnerReserve } from "../controllers/inventory.ownerreserve.controller";

const invenRouter = express.Router();

invenRouter.post(
    "/restock",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    restockInventory
);

invenRouter.get("/", rateLimiter, authMiddleWare, getInventoryByLocation);

invenRouter.post(
    "/dispatch",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN", "NGO_WORKER", "VOLUNTEER"]),
    dispatchInventory
);

invenRouter.get(
    "/ledger/:inventoryId",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    getInventoryLedger
);

invenRouter.patch(
    "/:id/owner-reserve",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    setOwnerReserve
);

export default invenRouter;