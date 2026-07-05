import express from "express";
import { authLimiter } from "../middlewares/rate_limit.middleware.ts";
import {
    userRegistrationController,
    userRefreshTokenController,
    userLoginController
} from "../controllers/user.controller.ts";

const authRoutes = express.Router();


authRoutes.post("/register", authLimiter, userRegistrationController);
authRoutes.post("/login", authLimiter, userLoginController);
authRoutes.post("/refresh-token", authLimiter, userRefreshTokenController);

export default authRoutes;