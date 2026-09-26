import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { safeRedis } from "../config/redis";
import { RedisKeys } from "../utils/redisKeys";
import { userModel } from "../models/user.model";

interface AccessTokenPayload {
    _id: string;
    email: string;
    role?: string;
    ngoId?: string;
}

export default async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        // 1. Extract access token from cookies or authorization header
        const token = req.cookies?.accessToken || req.headers.authorization?.split(" ")[1];
        if (!token) {
            return res.status(401).json({ status: "failed", message: "Authorization token missing." });
        }

        // 2. Verify JWT signature & expiration
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as AccessTokenPayload;
        const userIdStr = decoded._id;

        // 3. Check Redis for cached user profile
        const cachedProfile = await safeRedis.get(RedisKeys.userProfile(userIdStr));

        if (cachedProfile) {
            // Cache Hit: Instantly attach hydrated profile to req.user
            req.user = JSON.parse(cachedProfile);
            return next();
        }

        // 4. Cache Miss: Verify active session in Redis before querying DB
        const hasActiveSession = await safeRedis.exists(RedisKeys.userRefreshToken(userIdStr));
        if (!hasActiveSession) {
            return res.status(401).json({ status: "failed", message: "Session expired or logged out." });
        }

        // 5. Fallback to MongoDB if session is valid but profile cache missed
        const user = await userModel.findById(userIdStr).lean();
        if (!user) {
            return res.status(401).json({ status: "failed", message: "User account no longer exists." });
        }

        const userPayload = {
            _id: user._id.toString(),
            email: user.email,
            role: user.role,
            ngoId: user.ngoId?.toString()
        };

        // Re-prime profile cache in Redis (24 Hour TTL)
        await safeRedis.set(
            RedisKeys.userProfile(userIdStr),
            JSON.stringify(userPayload),
            { EX: 24 * 60 *  60 }
        );

        req.user = userPayload;
        next();

    } catch (error: any) {
        console.error(`Error in auth middleware: ${error.message}`);
        return res.status(401).json({
            status: "failed",
            message: "Unauthorized access. Token is invalid or expired."
        });
    }
};