import express from "express";
import { authLimiter } from "../middlewares/rate_limit.middleware.ts";
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
    addCoWorkerController
} from "../controllers/user.controller.ts";
import authMiddleware from "../middlewares/auth.middleware.ts";
import { verifyInternalKey } from "../middlewares/verifyinternalKey.ts";

const authRouter = express.Router();


authRouter.post("/register", authLimiter, userRegistrationController);
authRouter.patch("/internal/promote-founder", verifyInternalKey, promoteFounderController);
authRouter.patch("/internal/add-joined-ngo", verifyInternalKey, addCoWorkerController);
authRouter.post("/google-auth", authLimiter, googleAuthController);
authRouter.post("/login", authLimiter, userLoginController);
authRouter.post("/refresh-token", authLimiter, userRefreshTokenController);
authRouter.post("/logout", authLimiter, userLogoutController);
authRouter.get("/me", authLimiter, authMiddleware, getUserProfileController);
authRouter.post("/forgot-password", authLimiter, forgotPasswordController);
authRouter.delete("/delete", authLimiter, authMiddleware, deleteUserController);
authRouter.patch("/reset-password/:token", authLimiter, resetPasswordController);

export default authRouter;