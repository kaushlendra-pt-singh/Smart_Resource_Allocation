import express from "express";
import mongoose from "mongoose";
import rateLimiter from "../middlewares/rateLimit.middleware";

import {
    registerNGOController,
    getUploadSignatureController,
    verifyNGOController,
    getPendingNGOsController,
    addMemberController,
    getNgoByIdController,
    listNgosController,
    getNgoMembersController,
    cleanupDeletedUserController,
    updateNgoProfileController,
    transferOwnershipController,
    removeMemberController,
    bulkVerifyNGOsController,
    bulkDeleteNGOsController,
    deleteNgoController
} from "../controllers/ngo.controllers";

import { authMiddleWare, requireRoles } from "../middlewares/auth.middleware";
import { optionalAuth } from "../middlewares/optionalAuth";
import { verifyInternalKey } from "../middlewares/verufyInternalKey";

const ngoRouter = express.Router();

// Reject malformed ids up front (otherwise Mongo throws a CastError -> 500)
const validateObjectIdParam = (req: express.Request, res: express.Response, next: express.NextFunction, value: string) => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
        return res.status(400).json({ status: "failed", message: `Invalid id: ${value}` });
    }
    next();
};
ngoRouter.param("ngoId", validateObjectIdParam);
ngoRouter.param("memberId", validateObjectIdParam);
ngoRouter.param("userId", validateObjectIdParam);

// ==========================================
// 1. Internal Interservice Routes (No Rate Limiter)
// ==========================================
ngoRouter.delete(
    "/internal/users/:userId/cleanup",
    verifyInternalKey,
    cleanupDeletedUserController
);

// ==========================================
// 2. Static Specific Routes (Public / Protected)
// ==========================================
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
    "/bulk-verify",
    rateLimiter,
    authMiddleWare,
    requireRoles(['SUPER_ADMIN']),
    bulkVerifyNGOsController
);

ngoRouter.delete(
    "/bulk-delete",
    rateLimiter,
    authMiddleWare,
    requireRoles(['SUPER_ADMIN']),
    bulkDeleteNGOsController
);

ngoRouter.get(
    "/",
    rateLimiter,
    optionalAuth,
    listNgosController
);

// ==========================================
// 3. Parameterized NGO Specific Routes (/:ngoId)
// ==========================================
ngoRouter.get(
    "/:ngoId",
    rateLimiter,
    optionalAuth,
    getNgoByIdController
);

ngoRouter.get(
    "/:ngoId/members",
    rateLimiter,
    authMiddleWare,
    getNgoMembersController
);

ngoRouter.post(
    "/:ngoId/members",
    rateLimiter,
    authMiddleWare,
    requireRoles(['NGO_ADMIN', 'SUPER_ADMIN']),
    addMemberController
);

ngoRouter.delete(
    "/:ngoId/members/:memberId",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    removeMemberController
);

ngoRouter.patch(
    "/:ngoId",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    updateNgoProfileController
);

ngoRouter.patch(
    "/:ngoId/verify",
    rateLimiter,
    authMiddleWare,
    requireRoles(['SUPER_ADMIN']),
    verifyNGOController
);

ngoRouter.patch(
    "/:ngoId/transfer-ownership",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    transferOwnershipController
);

ngoRouter.delete(
    "/:ngoId",
    rateLimiter,
    authMiddleWare,
    deleteNgoController
);

export default ngoRouter;