import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRoutes from "./routes/auth.routes";
import type { Request, Response } from "express";

const app = express();

app.use(express.json());
app.use(cors({
    credentials: true
}));
app.use(cookieParser());

app.get("/", (req: Request, res: Response) => {
    res.status(200).json({ service: "auth_svc", status: "UP", timestamp: new Date() });
});
app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({ service: "auth_svc", status: "UP", timestamp: new Date() });
});

app.get("/api/auth/health", (req: Request, res: Response) => {
    res.status(200).json({ service: "auth_svc", status: "UP", timestamp: new Date() });
});

app.use("/api/auth", authRoutes);

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Unhandled Error in auth svc:", err);
    res.status(500).json({
        status: "failed",
        message: "Internal server error."
    });
});

export default app;