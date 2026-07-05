import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

async function authMiddleware(req:Request, res:Response, next:NextFunction) {

    try {
        const token = req.cookies?.accessToken || req.headers.authorization?.split(" ")[1];
        if(!token) return res.status(401).json({"message":"User not authorized!"});
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as {
            userId: string;
            role: string;
            ngoId: string | null;
        };
        req.user = {
            _id: decoded.userId, // Aligned with 'userId' from login/register controllers
            role: decoded.role,
            ngoId: decoded.ngoId
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

export default authMiddleware;