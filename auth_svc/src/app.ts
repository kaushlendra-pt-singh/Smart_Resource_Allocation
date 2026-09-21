import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRoutes from "./routes/auth.routes";

const app = express();

app.use(express.json());
app.use(cors({
    credentials: true
}));
app.use(cookieParser());

app.get("/",(req, res)=>{
    return res.status(200).json({"message":"All good at auth_svc server."});
})


app.get("/api/auth/health",(req, res)=>{
    return res.status(200).json({"message":"Server is healthy"});
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