import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import ngoRouter from "./routes/ngo.routes";

const app = express();
app.use(express.json());
app.use(cors());
app.use(cookieParser());

app.get("/",(req, res)=>{
    return res.status(200).json({"message":"All good at ngo_svc server.", "status":"success"});
});

app.get("/api/ngo/health",(req, res)=>{
    return res.status(200).json({"message":"NGO Management Service is healthy", "status":"success"});
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