import express from "express";
import { authMiddleWare, requireRoles } from "../middlewares/auth.middleware";
import rateLimiter from "../middlewares/rateLimiter";
import {
    dispatchInventory,
    getInventoryByLocation,
    getInventoryLedger,
    restockInventory
} from "../controllers/inventory.controller";

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
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    dispatchInventory
);

invenRouter.get(
    "/ledger/:inventoryId",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    getInventoryLedger
);

export default invenRouter;