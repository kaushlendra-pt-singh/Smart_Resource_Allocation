import express from "express";
import { verifyInternalKey } from "../middlewares/verifyInternalKey";
import { cancelReservationInternal, reserveStockInternal, dispatchHoldInternal } from "../controllers/reserve.controller";

// Internal routes (called by allocation_svc with x-internal-key). No per-IP rate limiter here:
// every call comes from the allocation service's IP, so a limiter would block real allocations.
const reserveRouter = express.Router();

reserveRouter.post("/reserve", verifyInternalKey, reserveStockInternal);

reserveRouter.post("/cancel-reservation", verifyInternalKey, cancelReservationInternal);

// Turns a held reservation into shipped stock (called by allocation_svc)
reserveRouter.post("/dispatch", verifyInternalKey, dispatchHoldInternal);

export default reserveRouter;
