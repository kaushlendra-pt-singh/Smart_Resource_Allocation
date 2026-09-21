import express from "express";
import rateLimiter from "../middlewares/rateLimiter";
import { verifyInternalKey } from "../middlewares/verifyInternalKey";
import { cancelReservationInternal, reserveStockInternal } from "../controllers/reserve.controller";

const reserveRouter = express.Router();

reserveRouter.post("/reserve", rateLimiter, verifyInternalKey, reserveStockInternal);

reserveRouter.post(
    "/cancel-reservation",
    rateLimiter,
    verifyInternalKey,
    cancelReservationInternal
);

export default reserveRouter;