import express from "express";
import rateLimiter from "../middlewares/rateLimit.middleware.ts";

import {
    registerNGOController,
    getUploadSignatureController,
    verifyNGOController,
    getPendingNGOsController,
    addCoAdminController
} from "../controllers/ngo.controllers.ts";

import {verifyToken, requireRoles} from "../middlewares/auth.middleware.ts";

const ngoRouter = express.Router();

//these routes are not tested yet
ngoRouter.post("/register",
    rateLimiter,
    verifyToken,
    registerNGOController
);

ngoRouter.get("/upload-signature",
    verifyToken,
    rateLimiter,
    getUploadSignatureController
);

ngoRouter.get(
    "/pending",
    verifyToken,
    requireRoles(['SUPER_ADMIN']),
    getPendingNGOsController
);

ngoRouter.patch(
    "/:ngoId/verify",
    verifyToken,
    requireRoles(['SUPER_ADMIN']),
    verifyNGOController
);

ngoRouter.post(
    "/:ngoId/add-admin",
    rateLimiter,
    verifyToken,
    requireRoles(['NGO_ADMIN', 'SUPER_ADMIN']),
    addCoAdminController
);

export default ngoRouter;