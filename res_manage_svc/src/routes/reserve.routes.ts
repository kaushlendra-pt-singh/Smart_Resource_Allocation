import express from "express";
import rateLimiter from "../middlewares/rateLimiter";
import { verifyInternalKey } from "../middlewares/verifyInternalKey";
import { cancelReservationInternal, reserveStockInternal, dispatchHoldInternal } from "../controllers/reserve.controller";

const reserveRouter = express.Router();

reserveRouter.post("/reserve", rateLimiter, verifyInternalKey, reserveStockInternal);

reserveRouter.post(
    "/cancel-reservation",
    rateLimiter,
    verifyInternalKey,
    cancelReservationInternal
);

// Turns a held reservation into shipped stock (called by allocation_svc)
reserveRouter.post("/dispatch", rateLimiter, verifyInternalKey, dispatchHoldInternal);

export default reserveRouter;