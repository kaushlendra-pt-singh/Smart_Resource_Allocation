import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import ngoRouter from "./routes/ngo.routes.ts";

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


export default app;