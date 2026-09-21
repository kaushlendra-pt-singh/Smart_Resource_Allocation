import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Inventory } from "../models/inventory.model";
import { InventoryLedger } from "../models/ledger.model";
import { safeRedis } from "../config/redis";
import { RedisKeys } from "../utils/redisKeys";

export const reserveStockInternal = async (req: Request, res: Response): Promise<Response> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { inventoryId, quantity, referenceId, performedBy = "allocation_svc", notes } = req.body;

        // 1. Validation
        if (!inventoryId || !quantity || !referenceId) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "inventoryId, quantity, and referenceId (NGO Request ID) are required."
            });
        }

        if (typeof quantity !== "number" || quantity <= 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "Quantity must be a positive number greater than 0."
            });
        }

        if (!mongoose.Types.ObjectId.isValid(inventoryId as string)) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "Invalid inventoryId format."
            });
        }

        // 2. Fetch inventory record within session for precision check
        const existingInventory = await Inventory.findById(inventoryId).session(session);

        if (!existingInventory) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({
                status: "failed",
                message: `Inventory document with ID ${inventoryId} not found.`
            });
        }

        // Calculate current liquid available stock
        const currentAvailable = existingInventory.totalQuantity - existingInventory.reservedQuantity;

        if (currentAvailable < quantity) {
            await session.abortTransaction();
            session.endSession();
            return res.status(409).json({
                status: "failed",
                message: `Insufficient available stock for reservation. Available: ${currentAvailable}, Requested: ${quantity}.`,
                data: {
                    inventoryId,
                    totalQuantity: existingInventory.totalQuantity,
                    reservedQuantity: existingInventory.reservedQuantity,
                    availableQuantity: currentAvailable
                }
            });
        }

        // 3. Atomic Reservation via $expr (Guarantees race-condition protection in MongoDB)
        // Match condition: (totalQuantity - reservedQuantity) >= quantity
        const updatedInventory = await Inventory.findOneAndUpdate(
            {
                _id: inventoryId,
                $expr: {$gte: [
                        { $subtract: ["$totalQuantity", "$reservedQuantity"] },
                        quantity
                    ]
                }
            },
            {
                $inc: { reservedQuantity: quantity }
            },
            {
                new: true,
                session,
                runValidators: true
            }
        );

        if (!updatedInventory) {
            await session.abortTransaction();
            session.endSession();
            return res.status(409).json({
                status: "failed",
                message: "Stock reservation failed due to a concurrent reservation lock conflict."
            });
        }

        // 4. Create Ledger Audit Entry (Linked to referenceId)
        await InventoryLedger.create(
            [
                {
                    inventoryId: updatedInventory._id,
                    resourceId: updatedInventory.resourceId,
                    action: "RESERVE",
                    quantity: quantity,
                    referenceId: referenceId.trim(),
                    performedBy: performedBy.trim(),
                    notes: notes
                        ? notes.trim()
                        : `Reserved ${quantity} units for referenceId: ${referenceId}`
                }
            ],
            { session }
        );

        // 5. Commit DB Transaction
        await session.commitTransaction();
        session.endSession();

        // 6. Redis Sync
        const inventoryIdStr = updatedInventory._id.toString();
        const resourceIdStr = updatedInventory.resourceId.toString();
        const newAvailableQty = updatedInventory.totalQuantity - updatedInventory.reservedQuantity;

        const stockPayload = JSON.stringify({
            inventoryId: inventoryIdStr,
            ngoId: updatedInventory.ngoId,
            resourceId: resourceIdStr,
            totalQuantity: updatedInventory.totalQuantity,
            reservedQuantity: updatedInventory.reservedQuantity,
            availableQuantity: newAvailableQty
        });

        await Promise.all([
            safeRedis.set(RedisKeys.inventoryStock(inventoryIdStr), stockPayload, { EX: 86400 }),
            safeRedis.set(RedisKeys.warehouseResourceStock(updatedInventory.warehouseName, resourceIdStr), stockPayload, { EX: 86400 }),
            // Set temporary reservation lock in Redis for allocation tracking (Key #6)
            safeRedis.set(RedisKeys.reservationLock(inventoryIdStr), referenceId, { EX: 600 }) // 10 min lock TTL
        ]);

        return res.status(200).json({
            status: "success",
            message: `Successfully reserved ${quantity} units for referenceId ${referenceId}.`,
            data: {
                inventoryId: updatedInventory._id,
                referenceId,
                totalQuantity: updatedInventory.totalQuantity,
                reservedQuantity: updatedInventory.reservedQuantity,
                availableQuantity: newAvailableQty
            }
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error in reserveStockInternal:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while reserving stock."
        });
    }
};

export const cancelReservationInternal = async (req: Request, res: Response): Promise<Response> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { inventoryId, quantity, referenceId, performedBy = "allocation_svc", notes } = req.body;

        // 1. Validation
        if (!inventoryId || !quantity || !referenceId) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "inventoryId, quantity, and referenceId are required."
            });
        }

        if (typeof quantity !== "number" || quantity <= 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "Quantity must be a positive number greater than 0."
            });
        }

        if (!mongoose.Types.ObjectId.isValid(inventoryId as string)) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "Invalid inventoryId format."
            });
        }

        // 2. Fetch inventory record inside session
        const existingInventory = await Inventory.findById(inventoryId).session(session);

        if (!existingInventory) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({
                status: "failed",
                message: `Inventory document with ID ${inventoryId} not found.`
            });
        }

        // Guard: Cannot release more stock than is currently marked as reserved
        if (existingInventory.reservedQuantity < quantity) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: `Cannot release ${quantity} units. Current reserved quantity is only ${existingInventory.reservedQuantity}.`,
                data: {
                    inventoryId,
                    totalQuantity: existingInventory.totalQuantity,
                    reservedQuantity: existingInventory.reservedQuantity
                }
            });
        }

        // 3. Atomic Decrement of reservedQuantity
        const updatedInventory = await Inventory.findOneAndUpdate(
            {
                _id: inventoryId,
                reservedQuantity: { $gte: quantity } // Double-check guard at execution time
            },
            {
                $inc: { reservedQuantity: -quantity }
            },
            {
                new: true,
                session,
                runValidators: true
            }
        );

        if (!updatedInventory) {
            await session.abortTransaction();
            session.endSession();
            return res.status(409).json({
                status: "failed",
                message: "Failed to release reservation due to a concurrent database lock conflict."
            });
        }

        // 4. Record CANCEL Ledger Audit Entry (Linked to referenceId)
        await InventoryLedger.create(
            [
                {
                    inventoryId: updatedInventory._id,
                    resourceId: updatedInventory.resourceId,
                    action: "CANCEL_RESERVATION",
                    quantity: -quantity, // Representing reduction in reserved hold
                    referenceId: referenceId.trim(),
                    performedBy: performedBy.trim(),
                    notes: notes
                        ? notes.trim()
                        : `Canceled reservation of ${quantity} units for referenceId: ${referenceId}`
                }
            ],
            { session }
        );

        // 5. Commit DB Transaction
        await session.commitTransaction();
        session.endSession();

        // 6. Redis Sync & Lock Cleanup
        const inventoryIdStr = updatedInventory._id.toString();
        const resourceIdStr = updatedInventory.resourceId.toString();
        const newAvailableQty = updatedInventory.totalQuantity - updatedInventory.reservedQuantity;

        const stockPayload = JSON.stringify({
            inventoryId: inventoryIdStr,
            ngoId: updatedInventory.ngoId,
            resourceId: resourceIdStr,
            totalQuantity: updatedInventory.totalQuantity,
            reservedQuantity: updatedInventory.reservedQuantity,
            availableQuantity: newAvailableQty
        });

        await Promise.all([
            // Update inventory caches so availableQuantity reflects released stock
            safeRedis.set(RedisKeys.inventoryStock(inventoryIdStr), stockPayload, { EX: 86400 }),
            safeRedis.set(RedisKeys.warehouseResourceStock(updatedInventory.warehouseName, resourceIdStr), stockPayload, { EX: 86400 }),
            // Remove temporary reservation lock in Redis (Key #6)
            safeRedis.del(RedisKeys.reservationLock(inventoryIdStr))
        ]);

        return res.status(200).json({
            status: "success",
            message: `Successfully canceled reservation of ${quantity} units for referenceId ${referenceId}.`,
            data: {
                inventoryId: updatedInventory._id,
                referenceId,
                totalQuantity: updatedInventory.totalQuantity,
                reservedQuantity: updatedInventory.reservedQuantity,
                availableQuantity: newAvailableQty
            }
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error in cancelReservationInternal:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while canceling stock reservation."
        });
    }
};
