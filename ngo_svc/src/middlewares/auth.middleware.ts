import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export async function authMiddleWare(req: Request, res: Response, next: NextFunction) {
    try {
        const token = req.cookies?.accessToken || req.headers.authorization?.split(" ")[1];
        if (!token) return res.status(401).json({ message: "User not authorized!" });

        // 1. Update the expected JWT payload structure
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as {
            _id: string;  // (Use userId if your login controller still signs it as userId)
            role: string;
            joinedNGOs: string[]; // <-- Updated to array
        };

        // 2. Map the array to the req.user object
        req.user = {
            _id: decoded._id, // Aligned with the JWT payload
            role: decoded.role,
            joinedNGOs: decoded.joinedNGOs || [] // <-- Safely maps the array (with a fallback)
        };

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
        if (!req.user || !allowedRoles.includes(req.user.role!)) {
            return res.status(403).json({ message: "Access Denied: Insufficient permissions." });
        }
        next();
    };
};