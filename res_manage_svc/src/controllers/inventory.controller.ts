import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Inventory } from "../models/inventory.model";
import type { IInventory } from "../models/inventory.model";
import { InventoryLedger } from "../models/ledger.model";
import { Resource } from "../models/resource.model";
import { safeRedis } from "../config/redis";
import { RedisKeys } from "../utils/redisKeys";
import { isValidCoordinates } from "../utils/validateCords";

type StockFields = { totalQuantity: number; reservedQuantity?: number; allocatedQuantity?: number };

const stockView = (inv: StockFields) => {
    const total = inv.totalQuantity ?? 0;
    const reserved = inv.reservedQuantity ?? 0;
    const allocated = inv.allocatedQuantity ?? 0; // ?? 0 keeps documents created before this field working
    return {
        totalQuantity: total,
        reservedQuantity: reserved,
        allocatedQuantity: allocated,
        availableQuantity: Math.max(0, total - allocated - reserved),
        ownerAvailableQuantity: Math.max(0, total - allocated)
    };
};

const buildStockPayload = (inv: IInventory): string =>
    JSON.stringify({
        inventoryId: inv._id.toString(),
        ngoId: inv.ngoId,
        resourceId: inv.resourceId.toString(),
        ...stockView(inv)
    });

// lean({ virtuals: true }) needs the mongoose-lean-virtuals plugin; this works without it
const withAvailability = (inv: any) => ({ ...inv, ...stockView(inv) });

export const restockInventory = async (req: Request, res: Response): Promise<Response> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { ngoId: bodyNgoId, resourceId, warehouseName, address, city, state, coordinates, quantity, notes } = req.body;
        const performedBy = req.user!._id; // from token, never from the body
        // SUPER_ADMIN may restock any NGO (must send ngoId); an NGO_ADMIN can only restock their own NGO
        const ngoId = req.user!.role === "SUPER_ADMIN" ? bodyNgoId : req.user!.ngoId;

        if (!ngoId || !resourceId || !warehouseName || !city || !state || !quantity) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "ngoId, resourceId, warehouseName, city, state, quantity, and performedBy are required."
            });
        }

        if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "Quantity must be a positive number greater than 0."
            });
        }

        if (!mongoose.Types.ObjectId.isValid(resourceId as string)) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "Invalid Resource ID format."
            });
        }

        // Verify resource existence
        const resourceExists = await Resource.findById(resourceId).session(session);
        if (!resourceExists) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({
                status: "failed",
                message: `Resource with ID ${resourceId} does not exist.`
            });
        }

        const existingInventory = await Inventory.findOne({
            ngoId,
            resourceId,
            warehouseName: warehouseName.trim()
        }).session(session);

        if (!existingInventory && (!coordinates || !isValidCoordinates(coordinates))) {
            await session.abortTransaction();
            session.endSession();

            return res.status(400).json({
                status: "failed",
                message: "Geospatial coordinates [longitude, latitude] are required when creating a new warehouse inventory record."
            });
        }

        // Upsert Inventory (Creates if new, increments totalQuantity if existing)
        const inventory = await Inventory.findOneAndUpdate(
            {
                ngoId,
                resourceId,
                warehouseName: warehouseName.trim()
            },
            {
                $inc: { totalQuantity: quantity }, $setOnInsert: {
                    ngoId,
                    resourceId,
                    warehouseName: warehouseName.trim(),
                    "location.city": city.trim(),
                    "location.state": state.trim(),
                    "location.address": (address == undefined || address == null) ? "" : address.trim(),
                    ...(coordinates ? { "location.coordinates": coordinates } : {})
                }
            },
            {
                returnDocument: "after",
                upsert: true,
                session,
                runValidators: true
            }
        );

        // Record Audit Ledger
        await InventoryLedger.create(
            [
                {
                    inventoryId: inventory._id,
                    resourceId,
                    action: "RESTOCK",
                    quantity,
                    performedBy: String(performedBy).trim(),
                    notes: notes ? notes.trim() : `Restocked ${quantity} units at ${warehouseName}`
                }
            ],
            { session }
        );

        await session.commitTransaction();
        session.endSession();

        // Redis is only a cache: a failure AFTER the DB commit must not turn a successful restock into an error
        try {
            const inventoryIdStr = inventory._id.toString();
            const stockPayload = buildStockPayload(inventory);
            await Promise.all([
                safeRedis.set(RedisKeys.inventoryStock(inventoryIdStr), stockPayload, { EX: 86400 }),
                safeRedis.set(
                    RedisKeys.warehouseResourceStock(warehouseName.trim(), resourceId as string),
                    stockPayload,
                    { EX: 86400 }
                ),
                // REMOVED: safeRedis.incrBy(resourceGlobalAvailableCount ...)
                // It drifts as soon as holds exist (reserve/cancel never touched it). Search the project for
                // resourceGlobalAvailableCount: if nothing reads it, delete the key from redisKeys.ts too.
                coordinates && coordinates.length === 2
                    ? safeRedis.geoAdd(
                        RedisKeys.warehouseLocations(),
                        coordinates[0],
                        coordinates[1],
                        `${warehouseName.trim()}:${inventoryIdStr}`
                    )
                    : Promise.resolve()
            ]);
        } catch (cacheErr) {
            console.error("Redis sync failed after restock (cache refreshes on TTL):", cacheErr);
        }

        return res.status(200).json({
            status: "success",
            message: `Successfully restocked ${quantity} units.`,
            data: {
                inventoryId: inventory._id,
                ngoId: inventory.ngoId,
                warehouseName: inventory.warehouseName,
                ...stockView(inventory)
            }
        });
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        session.endSession();
        console.error("Error in restockInventory:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while processing inventory restock."
        });
    }
};

export const getInventoryByLocation = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { warehouseName, resourceId, lng, lat, maxDistanceKm = "50", ngoId, page = "1", limit = "10" } = req.query;

        // 1. FAST PATH: Direct Redis Lookup using Key #3 (If searching by specific warehouse & resource)
        if (warehouseName && resourceId && typeof warehouseName === "string" && typeof resourceId === "string") {
            const cacheKey = RedisKeys.warehouseResourceStock(warehouseName.trim(), resourceId.trim());
            const cachedStock = await safeRedis.get(cacheKey);

            if (cachedStock) {
                const stockData = JSON.parse(cachedStock);
                return res.status(200).json({
                    status: "success",
                    message: "Inventory retrieved from Redis cache.",
                    data: [stockData],
                    source: "cache"
                });
            }
        }

        // 2. SLOW PATH: Query MongoDB for complex geospatial or filtered queries
        const filter: Record<string, any> = {};
        const countFilter: Record<string, any> = {};

        // Geospatial Radius Filter
        if (lng && lat) {
            const longitude = parseFloat(lng as string);
            const latitude = parseFloat(lat as string);
            const radiusKm = parseFloat(maxDistanceKm as string);

            if (!isNaN(longitude) && !isNaN(latitude) && !isNaN(radiusKm)) {
                // 1. $near for Inventory.find() -> sorts results by distance
                filter["location.coordinates"] = {
                    $near: {
                        $geometry: {
                            type: "Point",
                            coordinates: [longitude, latitude]
                        },
                        $maxDistance: radiusKm * 1000
                    }
                };

                // 2. $geoWithin + $centerSphere for Inventory.countDocuments() -> works in aggregation/count
                countFilter["location.coordinates"] = {
                    $geoWithin: {
                        $centerSphere: [[longitude, latitude], radiusKm / 6378.1]
                    }
                };
            }
        }

        if (warehouseName) {
            const trimmed = (warehouseName as string).trim();
            filter.warehouseName = trimmed;
            countFilter.warehouseName = trimmed;
        }

        if (ngoId) {
            const trimmed = (ngoId as string).trim();
            filter.ngoId = trimmed;
            countFilter.ngoId = trimmed;
        }

        if (resourceId) {
            if (!mongoose.Types.ObjectId.isValid(resourceId as string)) {
                return res.status(400).json({
                    status: "failed",
                    message: "Invalid resourceId format."
                });
            }
            filter.resourceId = resourceId;
            countFilter.resourceId = resourceId;
        }

        const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
        const limitNum = Math.max(1, parseInt(limit as string, 10) || 10);
        const skip = (pageNum - 1) * limitNum;

        const [inventoryItems, totalCount] = await Promise.all([
            Inventory.find(filter)
                .populate({
                    path: "resourceId",
                    select: "name category unit isPerishable"
                })
                .skip(skip)
                .limit(limitNum)
                .lean({ virtuals: true }),
            Inventory.countDocuments(countFilter) // Uses $geoWithin instead of $near
        ]);

        return res.status(200).json({
            status: "success",
            message: "Nearby inventory retrieved successfully.",
            data: inventoryItems.map(withAvailability),
            source: "database",
            pagination: {
                totalItems: totalCount,
                currentPage: pageNum,
                totalPages: Math.ceil(totalCount / limitNum),
                pageSize: limitNum
            }
        });
    } catch (error) {
        console.error("Error in getInventoryByLocation:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while fetching location inventory."
        });
    }
};

export const dispatchInventory = async (req: Request, res: Response): Promise<Response> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    const fail = async (status: number, message: string): Promise<Response> => {
        if (session.inTransaction()) await session.abortTransaction();
        return res.status(status).json({ status: "failed", message });
    };

    try {
        const { inventoryId, quantity, recipientNgoId, notes } = req.body;
        const user = req.user!; // route is behind authMiddleWare

        // 1. Validation
        if (!inventoryId || !quantity) {
            return await fail(400, "inventoryId and quantity are required.");
        }
        if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
            return await fail(400, "Quantity must be a positive integer.");
        }
        if (!mongoose.Types.ObjectId.isValid(String(inventoryId))) {
            return await fail(400, "Invalid inventoryId format.");
        }

        // 2. Ownership: only the owning NGO's admin or a super admin (route already limits roles)
        const inventory = await Inventory.findById(inventoryId).session(session);
        if (!inventory) {
            return await fail(404, `Inventory document with ID ${inventoryId} not found.`);
        }
        if (user.role !== "SUPER_ADMIN" && inventory.ngoId !== user.ngoId) {
            return await fail(403, "Only the owning NGO's admin or a super admin can dispatch directly. Other NGOs must use allocation.");
        }

        // 3. Atomic: only unallocated stock may leave (total - allocated >= quantity)
        const updated = await Inventory.findOneAndUpdate(
            {
                _id: inventoryId,
                $expr: {
                    $gte: [{ $subtract: ["$totalQuantity", { $ifNull: ["$allocatedQuantity", 0] }] }, quantity]
                }
            },
            { $inc: { totalQuantity: -quantity } }, // reservedQuantity is a policy cap: never changed here
            { returnDocument: "after", session, runValidators: true }
        );
        if (!updated) {
            const unallocated = Math.max(0, inventory.totalQuantity - (inventory.allocatedQuantity ?? 0));
            return await fail(409, `Insufficient unallocated stock. Unallocated: ${unallocated}, requested: ${quantity}.`);
        }

        // 4. Ledger (no referenceId: this shipment is not tied to an allocation)
        await InventoryLedger.create(
            [
                {
                    inventoryId: updated._id,
                    resourceId: updated.resourceId,
                    action: "DISPATCH",
                    quantity: -quantity,
                    performedBy: user._id,
                    notes: notes
                        ? String(notes).trim()
                        : `Direct dispatch of ${quantity} units${recipientNgoId ? ` to NGO ${recipientNgoId}` : ""} from ${updated.warehouseName}`
                }
            ],
            { session }
        );

        await session.commitTransaction();

        // 5. Non-fatal cache sync
        try {
            const idStr = updated._id.toString();
            const payload = buildStockPayload(updated);
            await Promise.all([
                safeRedis.set(RedisKeys.inventoryStock(idStr), payload, { EX: 86400 }),
                safeRedis.set(RedisKeys.warehouseResourceStock(updated.warehouseName, updated.resourceId.toString()), payload, { EX: 86400 })
            ]);
        } catch (cacheErr) {
            console.error("Redis sync failed after dispatch (cache refreshes on TTL):", cacheErr);
        }

        return res.status(200).json({
            status: "success",
            message: `Successfully dispatched ${quantity} units.`,
            data: {
                inventoryId: updated._id,
                warehouseName: updated.warehouseName,
                dispatchedQuantity: quantity,
                ...stockView(updated)
            }
        });
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error("Error in dispatchInventory:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while dispatching inventory."
        });
    } finally {
        session.endSession();
    }
};

export const getInventoryLedger = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { inventoryId } = req.params;
        const { action, referenceId, page = "1", limit = "20" } = req.query;

        // 1. Validate Inventory ID Format
        if (!inventoryId || !mongoose.Types.ObjectId.isValid(inventoryId.toString())) {
            return res.status(400).json({
                status: "failed",
                message: "Valid inventoryId parameter is required."
            });
        }

        // 2. Verify Inventory Record Exists
        const inventoryDoc = await Inventory.findById(inventoryId).select("ngoId").lean();
        if (!inventoryDoc) {
            return res.status(404).json({
                status: "failed",
                message: `Inventory document with ID ${inventoryId} not found.`
            });
        }

        if (req.user?.role !== "SUPER_ADMIN" && inventoryDoc.ngoId !== req.user?.ngoId) {
            return res.status(403).json({
                status: "failed",
                message: "You can only view the ledger of your own NGO's inventory."
            });
        }

        // 3. Build Dynamic Query Filter
        const filter: Record<string, any> = { inventoryId };

        // Trace everything that happened for one allocation (e.g. ALLOC-1A2B3C4D)
        if (referenceId && typeof referenceId === "string") {
            filter.referenceId = referenceId.trim();
        }

        if (action && typeof action === "string") {
            const validActions = [
                "RESTOCK",
                "RESERVE",
                "DISPATCH",
                "CANCEL_RESERVATION",
                "ADJUSTMENT"
            ];
            const upperAction = action.toUpperCase().trim();

            if (!validActions.includes(upperAction)) {
                return res.status(400).json({
                    status: "failed",
                    message: `Invalid action filter. Allowed values: ${validActions.join(", ")}`
                });
            }

            filter.action = upperAction;
        }

        // 4. Pagination Settings
        const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
        const limitNum = Math.max(1, Math.min(100, parseInt(limit as string, 10) || 20)); // Cap limit at 100
        const skip = (pageNum - 1) * limitNum;

        // 5. Query Audit Ledger with Populated Resource Metadata
        const [ledgerEntries, totalCount] = await Promise.all([
            InventoryLedger.find(filter)
                .populate({
                    path: "resourceId",
                    select: "name category unit isPerishable"
                })
                .sort({ createdAt: -1 }) // Newest ledger entries first
                .skip(skip)
                .limit(limitNum)
                .lean(),
            InventoryLedger.countDocuments(filter)
        ]);

        return res.status(200).json({
            status: "success",
            message: `Retrieved ${ledgerEntries.length} ledger audit log(s) for inventory ${inventoryId}.`,
            data: ledgerEntries,
            pagination: {
                totalItems: totalCount,
                currentPage: pageNum,
                totalPages: Math.ceil(totalCount / limitNum),
                pageSize: limitNum
            }
        });
    } catch (error) {
        console.error("Error in getInventoryLedger:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while fetching inventory audit ledger."
        });
    }
};