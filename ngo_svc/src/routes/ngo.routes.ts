import express from "express";
import rateLimiter from "../middlewares/rateLimit.middleware.ts";

import {
    registerNGOController,
    getUploadSignatureController,
    verifyNGOController,
    getPendingNGOsController,
    addCoAdminController,
    addMemberController
} from "../controllers/ngo.controllers.ts";

import { authMiddleWare, requireRoles } from "../middlewares/auth.middleware.ts";

const ngoRouter = express.Router();

//these routes are not tested yet
ngoRouter.post(
    "/register",
    rateLimiter,
    authMiddleWare,
    registerNGOController
);

ngoRouter.get(
    "/upload-signature",
    rateLimiter,
    authMiddleWare,
    getUploadSignatureController
);

ngoRouter.get(
    "/pending",
    rateLimiter,
    authMiddleWare,
    requireRoles(['SUPER_ADMIN']),
    getPendingNGOsController
);

ngoRouter.patch(
    "/:ngoId/verify",
    rateLimiter,
    authMiddleWare,
    requireRoles(['SUPER_ADMIN']),
    verifyNGOController
);

ngoRouter.post(
    "/:ngoId/add-worker",
    rateLimiter,
    authMiddleWare,
    requireRoles(['NGO_ADMIN', 'SUPER_ADMIN']),
    addMemberController
);

export default ngoRouter;