import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Inventory } from "../models/inventory.model";
import type { IInventory } from "../models/inventory.model";
import { InventoryLedger } from "../models/ledger.model";
import { Resource } from "../models/resource.model";
import { safeRedis } from "../config/redis";
import { RedisKeys } from "../utils/redisKeys";
import { isAdminOf } from "../utils/access";
// Keep your existing imports: Request, Response, mongoose, Inventory, InventoryLedger, safeRedis, RedisKeys
//
// Route suggestion (behind your normal JWT auth, NOT the internal key):
//   PATCH /api/inventory/:id/owner-reserve   body: { reservedQuantity: number, notes?: string }

export const setOwnerReserve = async (req: Request, res: Response): Promise<Response> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    const reply = async (status: number, body: Record<string, unknown>): Promise<Response> => {
        if (session.inTransaction()) await session.abortTransaction();
        return res.status(status).json(body);
    };

    try {
        const id = String(req.params.id);
        const { reservedQuantity, notes } = req.body ?? {};
        const user = req.user;

        // 1. Auth & User Context Validation
        if (!user || !user._id || !user.role) {
            return await reply(401, { status: "failed", message: "Unauthorized: Missing or invalid user context." });
        }

        // 2. Inventory ID Validation (guard against Express string[] param type & invalid ObjectId)
        if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) {
            return await reply(400, { status: "failed", message: "Invalid inventory id." });
        }

        // 3. reservedQuantity Validation (finite non-negative integer)
        if (
            typeof reservedQuantity !== "number" ||
            !Number.isFinite(reservedQuantity) ||
            !Number.isInteger(reservedQuantity) ||
            reservedQuantity < 0
        ) {
            return await reply(400, { status: "failed", message: "reservedQuantity must be a non-negative integer." });
        }

        // 4. Optional notes Validation
        if (notes !== undefined && notes !== null && typeof notes !== "string") {
            return await reply(400, { status: "failed", message: "notes must be a string when provided." });
        }

        const inventory = await Inventory.findById(id).session(session);
        if (!inventory) {
            return await reply(404, { status: "failed", message: `Inventory ${id} not found.` });
        }

        // 2. Authorization: SUPER_ADMIN, or any admin of the owning NGO
        if (!isAdminOf(user, inventory.ngoId)) {
            return await reply(403, {
                status: "failed",
                message: "Only the owning NGO admin or a super admin can change the owner reserve."
            });
        }

        // 3. Idempotent set
        const previous = inventory.reservedQuantity;
        if (previous === reservedQuantity) {
            await session.abortTransaction();
            return res.status(200).json({ status: "success", message: "Owner reserve unchanged.", data: summarize(inventory) });
        }

        const updated = await Inventory.findOneAndUpdate(
            { _id: id },
            { $set: { reservedQuantity } },
            { returnDocument: "after", session, runValidators: true }
        );
        if (!updated) {
            return await reply(409, { status: "failed", message: "Concurrent update conflict. Retry." });
        }

        // 4. Audit (reservedQuantity is a policy value, not a stock movement: quantity = delta)
        await InventoryLedger.create(
            [
                {
                    inventoryId: updated._id,
                    resourceId: updated.resourceId,
                    action: "ADJUSTMENT",
                    quantity: reservedQuantity - previous,
                    referenceId: `OWNER-RESERVE-${updated._id.toString()}`,
                    performedBy: String(user?._id ?? "unknown"),
                    notes: notes
                        ? String(notes).trim()
                        : `OWNER_RESERVE_CHANGE: ${previous} -> ${reservedQuantity}`
                }
            ],
            { session }
        );

        await session.commitTransaction();

        // 5. Non-fatal cache refresh
        try {
            const idStr = updated._id.toString();
            const payload = JSON.stringify({
                inventoryId: idStr,
                ngoId: updated.ngoId,
                resourceId: updated.resourceId.toString(),
                totalQuantity: updated.totalQuantity,
                reservedQuantity: updated.reservedQuantity,
                allocatedQuantity: updated.allocatedQuantity,
                availableQuantity: Math.max(0, updated.totalQuantity - updated.allocatedQuantity - updated.reservedQuantity),
                ownerAvailableQuantity: Math.max(0, updated.totalQuantity - updated.allocatedQuantity)
            });
            await Promise.all([
                safeRedis.set(RedisKeys.inventoryStock(idStr), payload, { EX: 86400 }),
                safeRedis.set(RedisKeys.warehouseResourceStock(updated.warehouseName, updated.resourceId.toString()), payload, { EX: 86400 }),
                safeRedis.del(RedisKeys.allocationResourceIndex(updated.resourceId.toString()))
            ]);
        } catch (err) {
            console.error("Redis sync failed after owner-reserve update:", err);
        }

        return res.status(200).json({
            status: "success",
            message: `Owner reserve set to ${reservedQuantity} (was ${previous}).`,
            data: summarize(updated)
        });
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error("Error in setOwnerReserve:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error while updating owner reserve." });
    } finally {
        session.endSession();
    }
};

const summarize = (inv: IInventory) => ({
    inventoryId: inv._id,
    totalQuantity: inv.totalQuantity,
    allocatedQuantity: inv.allocatedQuantity,
    reservedQuantity: inv.reservedQuantity,                              // the owner's target floor
    effectiveReserved: Math.min(inv.reservedQuantity, inv.totalQuantity), // what is actually backed by stock
    reserveShortfall: Math.max(0, inv.reservedQuantity - inv.totalQuantity),
    availableQuantity: Math.max(0, inv.totalQuantity - inv.allocatedQuantity - inv.reservedQuantity),
    ownerAvailableQuantity: Math.max(0, inv.totalQuantity - inv.allocatedQuantity)
});