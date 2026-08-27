import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

interface AccessTokenPayload {
    _id: string;
    role: string;
    email: string;
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
    let token: string | undefined = req.cookies?.accessToken;

    // Safely extract token from Authorization header if cookie is absent
    const authHeader = req.headers.authorization;
    if (!token && authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.split(" ")[1];
    }

    // No token provided -> Proceed as unauthenticated guest
    if (!token) {
        return next();
    }

    try {
        const decoded = jwt.verify(
            token,
            process.env.JWT_ACCESS_SECRET!
        ) as AccessTokenPayload;

        req.user = {
            _id: decoded._id,
            role: decoded.role,
            email: decoded.email,
        };
    } catch (error) {
        // Token invalid/expired -> Clear user context & continue as guest
        req.user = undefined;
    }

    return next();
}