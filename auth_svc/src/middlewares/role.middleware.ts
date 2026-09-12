import type { Request, Response, NextFunction } from "express";

export const requireRoles = (allowedRoles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user || !req.user.role || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ message: "Access Denied: Insufficient permissions." });
        }
        next();
    };
};