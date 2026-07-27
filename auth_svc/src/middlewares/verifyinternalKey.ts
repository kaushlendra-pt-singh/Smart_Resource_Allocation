import type {Request, Response, NextFunction} from "express";

export const verifyInternalKey = (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers["x-internal-key"];
    if (!apiKey || apiKey !== process.env.INTERNAL_API_KEY) {
        return res.status(403).json({ status: "failed", message: "Forbidden: Invalid internal API key." });
    }
    next();
};