import express from "express";
import { rateLimiter } from "../middlewares/rate_limit.middleware.ts";
import {
    userRegistrationController,
    promoteFounderController,
    userRefreshTokenController,
    userLoginController,
    userLogoutController,
    getUserProfileController,
    forgotPasswordController,
    resetPasswordController,
    deleteUserController,
    googleAuthController,
    addCoWorkerController,
    transferFounderRoleInternalController,
    removeNgoFromUserListInternalController,
    cleanupDeletedNgoInternalController
} from "../controllers/user.controller.ts";
import authMiddleware from "../middlewares/auth.middleware.ts";
import { verifyInternalKey } from "../middlewares/verifyinternalKey.ts";

const authRouter = express.Router();


authRouter.post("/register", rateLimiter, userRegistrationController);
authRouter.patch("/internal/promote-founder", verifyInternalKey, promoteFounderController);
authRouter.patch("/internal/add-joined-ngo", verifyInternalKey, addCoWorkerController);
authRouter.post(
    "/users/transfer-founder",
    rateLimiter,
    verifyInternalKey,
    transferFounderRoleInternalController
);
authRouter.post("/internal/users/remove-ngo-from-userList",
    rateLimiter,
    verifyInternalKey,
    removeNgoFromUserListInternalController
);
authRouter.post(
    "/ngos/cleanup-deleted-ngo",
    rateLimiter,
    verifyInternalKey,
    cleanupDeletedNgoInternalController
);
authRouter.post("/google-auth", rateLimiter, googleAuthController);
authRouter.post("/login", rateLimiter, userLoginController);
authRouter.post("/refresh-token", rateLimiter, userRefreshTokenController);
authRouter.post("/logout", rateLimiter, userLogoutController);
authRouter.get("/me", rateLimiter, authMiddleware, getUserProfileController);
authRouter.post("/forgot-password", rateLimiter, forgotPasswordController);
authRouter.delete("/delete", rateLimiter, authMiddleware, deleteUserController);
authRouter.patch("/reset-password/:token", rateLimiter, resetPasswordController);

export default authRouter;