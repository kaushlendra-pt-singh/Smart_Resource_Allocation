import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRoutes from "./routes/auth.routes.ts";

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

app.use("/api/auth/user", authRoutes);


export default app;