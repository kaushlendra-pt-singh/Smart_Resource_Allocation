import express from "express";
import { authMiddleWare, requireRoles } from "../middlewares/auth.middleware.ts";
import rateLimiter from "../middlewares/rateLimiter.ts";
import {
    dispatchInventory,
    getInventoryByLocation,
    restockInventory
} from "../controllers/inventory.controller.ts";

const invenRouter = express.Router();

invenRouter.post("/restock",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    restockInventory
);

invenRouter.get("/", rateLimiter, authMiddleWare, getInventoryByLocation);

invenRouter.post("/dispatch",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    dispatchInventory
);

export default invenRouter;