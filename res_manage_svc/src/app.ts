import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import resRouter from "./routes/resource.route";
import invenRouter from "./routes/inventory.route";
import reserveRouter from "./routes/reserve.routes";

const app: Express = express();

// See auth_svc/src/app.ts: real client IPs for the rate limiter when running behind nginx.
if (process.env.TRUST_PROXY_HOPS) {
    app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS));
}

app.use(helmet());
app.use(cors());
app.use(express.json());

// Healthcheck Route
app.get("/", (req: Request, res: Response) => {
    res.status(200).json({ service: "res_manage_svc", status: "UP", timestamp: new Date() });
});
app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({ service: "res_manage_svc", status: "UP", timestamp: new Date() });
});

app.get("/api/resources/health", (req: Request, res: Response) => {
    res.status(200).json({ service: "res_manage_svc", status: "UP", timestamp: new Date() });
});

app.use("/api/resources",resRouter);
app.use("/api/inventory", invenRouter);
app.use("/api/internal/inventory", reserveRouter);

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Unhandled Error in resource manage svc:", err);
    res.status(500).json({
        status: "failed",
        message: "Internal server error."
    });
});

export default app;