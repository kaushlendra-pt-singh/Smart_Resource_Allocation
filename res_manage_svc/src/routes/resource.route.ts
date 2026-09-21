import express from "express";
import { createResource, getAllResources, getResourceById } from "../controllers/resource.controller.ts";
import { authMiddleWare, requireRoles } from "../middlewares/auth.middleware.ts";
import rateLimiter from "../middlewares/rateLimiter.ts";

const resRouter = express.Router();

resRouter.post(
    "/",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    createResource
);

resRouter.get("/", rateLimiter, authMiddleWare, getAllResources);

resRouter.get("/:resourceId", rateLimiter, authMiddleWare, getResourceById);

export default resRouter;