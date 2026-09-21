import express from "express";
import { rateLimiter } from "../middlewares/rate_limit.middleware";
import {
    userRegistrationController,
    updateUserProfileController,
    promoteFounderController,
    userRefreshTokenController,
    userLoginController,
    userLogoutController,
    getUserProfileController,
    forgotPasswordController,
    resetPasswordController,
    deleteUserController,
    bulkDeleteUsersController,
    googleAuthController,
    addCoWorkerController,
    transferFounderRoleInternalController,
    removeNgoFromUserListInternalController,
    cleanupDeletedNgoInternalController
} from "../controllers/user.controller";
import authMiddleware from "../middlewares/auth.middleware";
import { requireRoles } from "../middlewares/role.middleware";
import { verifyInternalKey } from "../middlewares/verifyinternalKey";

const authRouter = express.Router();

// ==========================================
// 1. Internal Interservice Routes (No Rate Limiter)
// ==========================================
authRouter.patch("/internal/promote-founder", verifyInternalKey, promoteFounderController);
authRouter.patch("/internal/add-joined-ngo", verifyInternalKey, addCoWorkerController);

authRouter.post(
    "/internal/users/transfer-founder",
    verifyInternalKey,
    transferFounderRoleInternalController
);

authRouter.post(
    "/internal/users/remove-ngo-from-userList",
    verifyInternalKey,
    removeNgoFromUserListInternalController
);

authRouter.post(
    "/internal/ngos/cleanup-deleted-ngo",
    verifyInternalKey,
    cleanupDeletedNgoInternalController
);

// ==========================================
// 2. Public Authentication & Account Routes
// ==========================================
authRouter.post("/register", rateLimiter, userRegistrationController);
authRouter.patch("/profile", rateLimiter, authMiddleware, updateUserProfileController);
authRouter.post("/login", rateLimiter, userLoginController);
authRouter.post("/google-auth", rateLimiter, googleAuthController);
authRouter.post("/refresh-token", rateLimiter, userRefreshTokenController);
authRouter.post("/logout", rateLimiter, userLogoutController);
authRouter.post("/forgot-password", rateLimiter, forgotPasswordController);
authRouter.patch("/reset-password/:token", rateLimiter, resetPasswordController);

// ==========================================
// 3. User Session Routes
// ==========================================
authRouter.get("/me", rateLimiter, authMiddleware, getUserProfileController);
authRouter.delete("/delete", rateLimiter, authMiddleware, deleteUserController);
authRouter.delete(
    "/users/bulk-delete",
    rateLimiter,
    authMiddleware,
    requireRoles(['SUPER_ADMIN']),
    bulkDeleteUsersController
);

export default authRouter;