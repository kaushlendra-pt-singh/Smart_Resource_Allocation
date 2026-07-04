import express from "express";
import {
    userRegistrationController,
    userRefreshTokenController
} from "../controllers/user.controller.ts";

const authRoutes = express.Router();


authRoutes.post("/register", userRegistrationController);
authRoutes.post("/refresh-token", userRefreshTokenController);

export default authRoutes;