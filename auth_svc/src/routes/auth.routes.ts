import express from "express";
import { authLimiter } from "../middlewares/rate_limit.middleware.ts";
import {
    userRegistrationController,
    userRefreshTokenController,
    userLoginController,
    userLogoutController,
    getUserProfileController
} from "../controllers/user.controller.ts";
import authMiddleware from "../middlewares/auth.middleware.ts";

const authRoutes = express.Router();


authRoutes.post("/register", authLimiter, userRegistrationController);
authRoutes.post("/login", authLimiter, userLoginController);
authRoutes.post("/refresh-token", authLimiter, userRefreshTokenController);
authRoutes.post("/logout", authLimiter, userLogoutController);
authRoutes.get("/me", authLimiter, authMiddleware, getUserProfileController);

export default authRoutes;