import express from "express";
import rateLimiter from "../middlewares/rateLimit.middleware.ts";

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
    deleteNgoController
} from "../controllers/ngo.controllers.ts";

import { authMiddleWare, requireRoles } from "../middlewares/auth.middleware.ts";
import { optionalAuth } from "../middlewares/optionalAuth.ts";
import { verifyInternalKey } from "../middlewares/verufyInternalKey.ts";

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
    "/:ngoId/addMembers",
    rateLimiter,
    authMiddleWare,
    requireRoles(['NGO_ADMIN', 'SUPER_ADMIN']),
    addMemberController
);

ngoRouter.get("/",
    rateLimiter,
    optionalAuth,
    listNgosController
);

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

ngoRouter.delete(
    "/internal/users/:userId/cleanup",
    rateLimiter,
    verifyInternalKey,
    cleanupDeletedUserController
);

ngoRouter.patch(
    "/:ngoId",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    updateNgoProfileController
);

ngoRouter.patch(
    "/:ngoId/transfer-ownership",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    transferOwnershipController
);

ngoRouter.delete("/:ngoId/members/:memberId",
    rateLimiter,
    authMiddleWare,
    requireRoles(["SUPER_ADMIN", "NGO_ADMIN"]),
    removeMemberController
);

ngoRouter.delete(
    "/:ngoId",
    rateLimiter,
    authMiddleWare,
    deleteNgoController
);

export default ngoRouter;