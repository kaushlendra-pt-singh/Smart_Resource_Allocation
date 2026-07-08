import express from "express";
import { authLimiter } from "../middlewares/rate_limit.middleware.ts";
import {
    userRegistrationController,
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

const authRoutes = express.Router();


authRoutes.post("/register", authLimiter, userRegistrationController);
authRoutes.post("/google-auth", authLimiter, googleAuthController);
authRoutes.post("/login", authLimiter, userLoginController);
authRoutes.post("/refresh-token", authLimiter, userRefreshTokenController);
authRoutes.post("/logout", authLimiter, userLogoutController);
authRoutes.get("/me", authLimiter, authMiddleware, getUserProfileController);
authRoutes.post("/forgot-password", authLimiter, forgotPasswordController);
authRoutes.delete("/delete", authLimiter, authMiddleware, deleteUserController);
authRoutes.patch("/reset-password/:token", authLimiter, resetPasswordController);

export default authRoutes;