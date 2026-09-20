import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";

const app: Express = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// Healthcheck Route
app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({ service: "res_manage_svc", status: "UP", timestamp: new Date() });
});

export default app;