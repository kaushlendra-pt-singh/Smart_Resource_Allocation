import express from "express";
import { authLimiter } from "../middlewares/rate_limit.middleware.ts";
import {
    userRegistrationController,
    promoteFounderController,
    promoteCoAdminController,
    userRefreshTokenController,
    userLoginController,
    userLogoutController,
    getUserProfileController,
    forgotPasswordController,
    resetPasswordController,
    deleteUserController,
    googleAuthController
} from "../controllers/user.controller.ts";
import authMiddleware from "../middlewares/auth.middleware.ts";

const authRouter = express.Router();


authRouter.post("/register", authLimiter, userRegistrationController);
authRouter.patch("/internal/promote-founder", promoteFounderController);
authRouter.patch("/internal/promote-coadmin", promoteCoAdminController);
authRouter.post("/google-auth", authLimiter, googleAuthController);
authRouter.post("/login", authLimiter, userLoginController);
authRouter.post("/refresh-token", authLimiter, userRefreshTokenController);
authRouter.post("/logout", authLimiter, userLogoutController);
authRouter.get("/me", authLimiter, authMiddleware, getUserProfileController);
authRouter.post("/forgot-password", authLimiter, forgotPasswordController);
authRouter.delete("/delete", authLimiter, authMiddleware, deleteUserController);
authRouter.patch("/reset-password/:token", authLimiter, resetPasswordController);

export default authRouter;