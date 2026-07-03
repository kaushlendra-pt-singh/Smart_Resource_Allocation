import express from "express";
import cookieParser from "cookie-parser";

const app = express();

app.use(express.json());
app.use(cookieParser());

app.get("/",(req, res)=>{
    return res.status(200).json({"message":"All good at auth_svc server."});
})


app.get("/api/health",(req, res)=>{
    return res.status(200).json({"message":"Server is healthy"});
});


export default app;