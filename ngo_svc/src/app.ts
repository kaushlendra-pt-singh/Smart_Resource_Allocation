import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import ngoRouter from "./routes/ngo.routes";
import type { Request, Response } from "express";

const app = express();

// See auth_svc/src/app.ts: real client IPs for the rate limiter when running behind nginx.
if (process.env.TRUST_PROXY_HOPS) {
    app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS));
}

app.use(express.json());
app.use(cors());
app.use(cookieParser());

app.get("/", (req: Request, res: Response) => {
    res.status(200).json({ service: "ngo_svc", status: "UP", timestamp: new Date() });
});
app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({ service: "ngo_svc", status: "UP", timestamp: new Date() });
});

app.get("/api/ngo/health", (req: Request, res: Response) => {
    res.status(200).json({ service: "ngo_svc", status: "UP", timestamp: new Date() });
});

app.use("/api/ngo", ngoRouter);

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Unhandled Error in ngo svc:", err);
    res.status(500).json({
        status: "failed",
        message: "Internal server error."
    });
});

export default app;