import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export const verifyInternalKey = (req: Request, res: Response, next: NextFunction): Response | void => {
    const rawApiKey = req.headers["x-internal-key"];
    const expectedKey = process.env.INTERNAL_API_KEY;

    // 1. Guard against missing server configuration
    if (!expectedKey) {
        console.error("[SECURITY WARNING] INTERNAL_API_KEY is not defined in environment variables.");
        return res.status(500).json({
            status: "failed",
            message: "Internal server security configuration error."
        });
    }

    // 2. Handle header array edge case and missing header
    const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;

    if (!apiKey) {
        return res.status(403).json({
            status: "failed",
            message: "Forbidden: Missing internal API key."
        });
    }

    // 3. Constant-time comparison to prevent timing attacks
    const apiKeyBuffer = Buffer.from(apiKey);
    const expectedKeyBuffer = Buffer.from(expectedKey);

    if (
        apiKeyBuffer.length !== expectedKeyBuffer.length ||
        !crypto.timingSafeEqual(apiKeyBuffer, expectedKeyBuffer)
    ) {
        return res.status(403).json({
            status: "failed",
            message: "Forbidden: Invalid internal API key."
        });
    }

    next();
};