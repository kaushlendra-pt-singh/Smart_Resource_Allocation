import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AccessTokenPayload {
    _id: string;
    role: string;
    email: string;
    ngoId?: string | null; // NGO this user owns
    joinedNGOs?: { ngoId: string; roleInNGO: string }[];
}

export const userFromToken = (decoded: AccessTokenPayload) => ({
    _id: decoded._id,
    role: decoded.role,
    email: decoded.email,
    ngoId: decoded.ngoId || null,
    joinedNGOs: Array.isArray(decoded.joinedNGOs) ? decoded.joinedNGOs : []
});

export async function authMiddleWare(req: Request, res: Response, next: NextFunction) {
    try {
        const token = req.cookies?.accessToken || req.headers.authorization?.split(" ")[1];
        if (!token) return res.status(401).json({ message: "User not authorized!" });

        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as AccessTokenPayload;
        req.user = userFromToken(decoded);

        next();
    } catch (error: any) {
        console.error(`Error in auth middleware: ${error}`);
        return res.status(401).json({
            message: "Unauthorized access. Token is invalid or expired.",
            error: error.message
        });
    }
}

export const requireRoles = (allowedRoles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user || !req.user.role || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ message: "Access Denied: Insufficient permissions." });
        }
        next();
    };
};
