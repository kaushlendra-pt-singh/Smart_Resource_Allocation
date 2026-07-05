import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        const token = req.headers.authorization?.startsWith("Bearer ") 
            ? req.headers.authorization.split(" ")[1] 
            : null;
        
        if (!token) {
            return res.status(401).json({ message: "Access denied. Token missing from headers." });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as { 
            userId: string; 
            role: string; 
            ngoId: string | null; 
        };

        req.user = {
            _id: decoded.userId,
            role: decoded.role,
            ngoId: decoded.ngoId
        };

        next();
    } catch (error: any) {
        console.error(`Error in NGO auth middleware: ${error}`);
        return res.status(401).json({ message: "Unauthorized access. Invalid token." });
    }
}

export default authMiddleware;