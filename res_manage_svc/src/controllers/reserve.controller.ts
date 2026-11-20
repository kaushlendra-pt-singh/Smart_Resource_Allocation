import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Inventory } from "../models/inventory.model";
import type { IInventory } from "../models/inventory.model";
import { InventoryLedger } from "../models/ledger.model";
import { safeRedis } from "../config/redis";
import { RedisKeys } from "../utils/redisKeys";

// Keep your existing imports: Request, Response, mongoose, Inventory, IInventory, InventoryLedger, safeRedis, RedisKeys

type Body = Record<string, unknown>;

const abortAndRespond = async (
    session: mongoose.ClientSession,
    res: Response,
    statusCode: number,
    body: Body
): Promise<Response> => {
    if (session.inTransaction()) await session.abortTransaction();
    return res.status(statusCode).json(body);
};

const buildStockPayload = (inv: IInventory): string =>
    JSON.stringify({
        inventoryId: inv._id.toString(),
        ngoId: inv.ngoId,
        resourceId: inv.resourceId.toString(),
        totalQuantity: inv.totalQuantity,
        reservedQuantity: inv.reservedQuantity,   // owner-protected floor
        allocatedQuantity: inv.allocatedQuantity, // active allocation holds
        availableQuantity: Math.max(0, inv.totalQuantity - inv.allocatedQuantity - inv.reservedQuantity),
        ownerAvailableQuantity: Math.max(0, inv.totalQuantity - inv.allocatedQuantity)
    });

// Redis is a cache: a failure AFTER the DB commit must never turn a committed change into an error.
const syncRedis = async (inv: IInventory, lockOp: "set" | "del", referenceId: string): Promise<void> => {
    try {
        const id = inv._id.toString();
        const payload = buildStockPayload(inv);
        await Promise.all([
            safeRedis.set(RedisKeys.inventoryStock(id), payload, { EX: 86400 }),
            safeRedis.set(RedisKeys.warehouseResourceStock(inv.warehouseName, inv.resourceId.toString()), payload, { EX: 86400 }),
            lockOp === "set"
                ? safeRedis.set(RedisKeys.reservationLock(id), referenceId, { EX: 600 })
                : safeRedis.del(RedisKeys.reservationLock(id))
        ]);
    } catch (err) {
        console.error("Redis sync failed after commit (cache will refresh on TTL):", err);
    }
};

const stockData = (inv: IInventory, referenceId: string) => ({
    inventoryId: inv._id,
    referenceId,
    totalQuantity: inv.totalQuantity,
    reservedQuantity: inv.reservedQuantity,
    allocatedQuantity: inv.allocatedQuantity,
    availableQuantity: Math.max(0, inv.totalQuantity - inv.allocatedQuantity - inv.reservedQuantity),
    ownerAvailableQuantity: Math.max(0, inv.totalQuantity - inv.allocatedQuantity)
});

const getNetHold = async (
    inventoryId: string,
    referenceId: string,
    session: mongoose.ClientSession
): Promise<number> => {
    const agg = await InventoryLedger.aggregate([
        {
            $match: {
                inventoryId: new mongoose.Types.ObjectId(inventoryId),
                referenceId,
                action: { $in: ["RESERVE", "CANCEL_RESERVATION", "DISPATCH"] }
            }
        },
        { $group: { _id: null, net: { $sum: "$quantity" } } }
    ]).session(session);
    return agg[0]?.net ?? 0;
};

export const reserveStockInternal = async (req: Request, res: Response): Promise<Response> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const {
            inventoryId,
            quantity,
            referenceId,
            performedBy = "allocation_svc",
            notes,
            includeOwnerReserve = false // true => requester may use owner-protected stock (reservedQuantity)
        } = req.body;

        // 1. Validation
        if (!inventoryId || !quantity || !referenceId) {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "inventoryId, quantity, and referenceId (NGO Request ID) are required."
            });
        }
        if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "Quantity must be a positive integer."
            });
        }
        if (typeof includeOwnerReserve !== "boolean") {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "includeOwnerReserve must be a boolean."
            });
        }
        if (!mongoose.Types.ObjectId.isValid(inventoryId as string)) {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "Invalid inventoryId format."
            });
        }

        // 2. Precision check (gives a useful error message; the atomic update below is the real guard)
        const existing = await Inventory.findById(inventoryId).session(session);
        if (!existing) {
            return await abortAndRespond(session, res, 404, {
                status: "failed",
                message: `Inventory document with ID ${inventoryId} not found.`
            });
        }

        const floor = includeOwnerReserve ? 0 : existing.reservedQuantity;
        const usable = existing.totalQuantity - (existing.allocatedQuantity ?? 0) - floor;
        if (usable < quantity) {
            return await abortAndRespond(session, res, 409, {
                status: "failed",
                message: `Insufficient stock for reservation. Usable: ${Math.max(0, usable)}, Requested: ${quantity}.`,
                data: stockData(existing, referenceId)
            });
        }

        // 3. Atomic reservation: (total - allocated - (owner tier ? 0 : reserved)) >= quantity
        //    $ifNull keeps documents created before allocatedQuantity existed working.
        const floorExpr = includeOwnerReserve ? 0 : { $ifNull: ["$reservedQuantity", 0] };
        const updated = await Inventory.findOneAndUpdate(
            {
                _id: inventoryId,
                $expr: {
                    $gte: [
                        {
                            $subtract: [
                                { $subtract: ["$totalQuantity", { $ifNull: ["$allocatedQuantity", 0] }] },
                                floorExpr
                            ]
                        },
                        quantity
                    ]
                }
            },
            { $inc: { allocatedQuantity: quantity } },
            { returnDocument: "after", session, runValidators: true }
        );

        if (!updated) {
            return await abortAndRespond(session, res, 409, {
                status: "failed",
                message: "Stock reservation failed due to a concurrent reservation conflict."
            });
        }

        // 4. Ledger audit entry
        await InventoryLedger.create(
            [
                {
                    inventoryId: updated._id,
                    resourceId: updated.resourceId,
                    action: "RESERVE",
                    quantity,
                    referenceId: String(referenceId).trim(),
                    performedBy: String(performedBy).trim(),
                    notes: notes ? String(notes).trim() : `Reserved ${quantity} units for referenceId: ${referenceId}`
                }
            ],
            { session }
        );

        // 5. Commit, then (non-fatal) cache sync
        await session.commitTransaction();
        await syncRedis(updated, "set", String(referenceId));

        return res.status(200).json({
            status: "success",
            message: `Successfully reserved ${quantity} units for referenceId ${referenceId}.`,
            data: stockData(updated, referenceId)
        });
    } catch (error) {
        // inTransaction() is false after a successful commit, so this can never throw "abort after commit"
        if (session.inTransaction()) await session.abortTransaction();
        console.error("Error in reserveStockInternal:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while reserving stock."
        });
    } finally {
        session.endSession();
    }
};

export const cancelReservationInternal = async (req: Request, res: Response): Promise<Response> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { inventoryId, quantity, referenceId, performedBy = "allocation_svc", notes } = req.body;

        // 1. Validation
        if (!inventoryId || !quantity || !referenceId) {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "inventoryId, quantity, and referenceId are required."
            });
        }
        if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "Quantity must be a positive integer."
            });
        }
        if (!mongoose.Types.ObjectId.isValid(inventoryId as string)) {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "Invalid inventoryId format."
            });
        }

        const ref = String(referenceId).trim();

        // 2. Reference-scoped guard: only release what THIS referenceId still holds on THIS inventory.
        //    Without this, a rollback/ambiguous-cancel could free another allocation's hold.
        //    RESERVE rows are +qty, CANCEL_RESERVATION and DISPATCH rows are -qty, so the sum is the net hold.
        const heldForRef = await getNetHold(inventoryId, ref, session);

        if (heldForRef < quantity) {
            return await abortAndRespond(session, res, 409, {
                status: "failed",
                message: `No active hold of ${quantity} units for referenceId ${ref} on this inventory (held: ${heldForRef}).`
            });
        }

        // 3. Atomic decrement of allocatedQuantity (never touches the owner-protected reservedQuantity)
        const updated = await Inventory.findOneAndUpdate(
            { _id: inventoryId, allocatedQuantity: { $gte: quantity } },
            { $inc: { allocatedQuantity: -quantity } },
            { returnDocument: "after", session, runValidators: true }
        );

        if (!updated) {
            return await abortAndRespond(session, res, 409, {
                status: "failed",
                message: "Failed to release reservation: inventory not found or allocated quantity too low."
            });
        }

        // 4. Ledger audit entry
        await InventoryLedger.create(
            [
                {
                    inventoryId: updated._id,
                    resourceId: updated.resourceId,
                    action: "CANCEL_RESERVATION",
                    quantity: -quantity,
                    referenceId: ref,
                    performedBy: String(performedBy).trim(),
                    notes: notes ? String(notes).trim() : `Canceled reservation of ${quantity} units for referenceId: ${ref}`
                }
            ],
            { session }
        );

        // 5. Commit, then (non-fatal) cache sync
        await session.commitTransaction();
        await syncRedis(updated, "del", ref);

        return res.status(200).json({
            status: "success",
            message: `Successfully canceled reservation of ${quantity} units for referenceId ${ref}.`,
            data: stockData(updated, ref)
        });
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error("Error in cancelReservationInternal:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while canceling stock reservation."
        });
    } finally {
        session.endSession();
    }
};

export const dispatchHoldInternal = async (req: Request, res: Response): Promise<Response> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { inventoryId, quantity, referenceId, performedBy = "allocation_svc", notes } = req.body;

        // 1. Validation
        if (!inventoryId || !quantity || !referenceId) {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "inventoryId, quantity, and referenceId are required."
            });
        }
        if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "Quantity must be a positive integer."
            });
        }
        if (!mongoose.Types.ObjectId.isValid(inventoryId as string)) {
            return await abortAndRespond(session, res, 400, {
                status: "failed",
                message: "Invalid inventoryId format."
            });
        }

        const ref = String(referenceId).trim();

        // 2. Only what THIS reference still holds on THIS inventory can be dispatched
        const heldForRef = await getNetHold(inventoryId, ref, session);
        if (heldForRef < quantity) {
            return await abortAndRespond(session, res, 409, {
                status: "failed",
                message: `No active hold of ${quantity} units for referenceId ${ref} on this inventory (held: ${heldForRef}).`
            });
        }

        // 3. Atomic: stock leaves the shelf and the hold disappears together
        const updated = await Inventory.findOneAndUpdate(
            {
                _id: inventoryId,
                allocatedQuantity: { $gte: quantity },
                totalQuantity: { $gte: quantity }
            },
            { $inc: { allocatedQuantity: -quantity, totalQuantity: -quantity } },
            { returnDocument: "after", session, runValidators: true }
        );
        if (!updated) {
            return await abortAndRespond(session, res, 409, {
                status: "failed",
                message: "Dispatch failed: allocated or total quantity too low (concurrent update?)."
            });
        }

        // 4. Ledger
        await InventoryLedger.create(
            [
                {
                    inventoryId: updated._id,
                    resourceId: updated.resourceId,
                    action: "DISPATCH",
                    quantity: -quantity,
                    referenceId: ref,
                    performedBy: String(performedBy).trim(),
                    notes: notes ? String(notes).trim() : `Dispatched ${quantity} held units for referenceId: ${ref}`
                }
            ],
            { session }
        );

        await session.commitTransaction();
        await syncRedis(updated, "del", ref);

        return res.status(200).json({
            status: "success",
            message: `Successfully dispatched ${quantity} units for referenceId ${ref}.`,
            data: stockData(updated, ref)
        });
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error("Error in dispatchHoldInternal:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while dispatching held stock."
        });
    } finally {
        session.endSession();
    }
};