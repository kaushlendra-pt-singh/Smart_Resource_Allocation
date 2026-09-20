import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import resRouter from "./routes/resource.route";

const app: Express = express();

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

app.use("/api/resources",resRouter);

export default app;