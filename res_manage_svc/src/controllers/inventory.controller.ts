import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Inventory } from "../models/inventory.model";
import { InventoryLedger } from "../models/ledger.model";
import { Resource } from "../models/resource.model";
import { safeRedis } from "../config/redis";
import { RedisKeys } from "../utils/redisKeys";
import { isValidCoordinates } from "../utils/validateCords";

export const restockInventory = async (req: Request, res: Response): Promise<Response> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { ngoId, resourceId, warehouseName, address, city, state, coordinates, quantity, performedBy, notes } = req.body;

        if (!ngoId || !resourceId || !warehouseName || !city || !state || !quantity || !performedBy) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "ngoId, resourceId, warehouseName, city, state, quantity, and performedBy are required."
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

        if (!mongoose.Types.ObjectId.isValid(resourceId as string)) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "Invalid Resource ID format."
            });
        }

        // Verify resource existence
        const resourceExists = await Resource.findById({ ngoId, resourceId }).session(session);
        if (!resourceExists) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({
                status: "failed",
                message: `Resource with ID ${resourceId} does not exist.`
            });
        }

        if (!resourceExists && (!coordinates || !isValidCoordinates(coordinates))) {
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
                    "location.address": address.trim() || "",
                    ...(coordinates ? { "location.coordinates": coordinates } : {})
                }
            },
            {
                new: true,
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
                    performedBy: performedBy.trim(),
                    notes: notes ? notes.trim() : `Restocked ${quantity} units at ${warehouseName}`
                }
            ],
            { session }
        );

        await session.commitTransaction();
        session.endSession();

        // Sync with Redis using correct wrapper methods
        const inventoryIdStr = inventory._id.toString();
        const availableQty = Math.max(0, inventory.totalQuantity - inventory.reservedQuantity);

        const stockPayload = JSON.stringify({
            inventoryId: inventoryIdStr,
            ngoId,
            resourceId,
            totalQuantity: inventory.totalQuantity,
            reservedQuantity: inventory.reservedQuantity,
            availableQuantity: availableQty
        });

        await Promise.all([
            // 1. Inventory stock details by inventory ID
            safeRedis.set(RedisKeys.inventoryStock(inventoryIdStr), stockPayload, { EX: 86400 }),

            // 2. Warehouse & Resource mapping details
            safeRedis.set(
                RedisKeys.warehouseResourceStock(warehouseName.trim(), resourceId as string),
                stockPayload,
                { EX: 86400 }
            ),

            // 3. Atomically increment global available stock by the restocked quantity!
            safeRedis.incrBy(
                RedisKeys.resourceGlobalAvailableCount(resourceId as string),
                quantity
            ),

            // 4. Update geospatial index
            coordinates && coordinates.length === 2
                ? safeRedis.geoAdd(
                    RedisKeys.warehouseLocations(),
                    coordinates[0],
                    coordinates[1],
                    `${warehouseName.trim()}:${inventoryIdStr}`
                )
                : Promise.resolve()
        ]);

        return res.status(200).json({
            status: "success",
            message: `Successfully restocked ${quantity} units.`,
            data: {
                inventoryId: inventory._id,
                ngoId: inventory.ngoId,
                warehouseName: inventory.warehouseName,
                totalQuantity: inventory.totalQuantity,
                reservedQuantity: inventory.reservedQuantity,
                availableQuantity: availableQty
            }
        });
    } catch (error) {
        await session.abortTransaction();
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

        // Geospatial Radius Filter ($near using 2dsphere index)
        if (lng && lat) {
            const longitude = parseFloat(lng as string);
            const latitude = parseFloat(lat as string);
            const maxMeters = parseFloat(maxDistanceKm as string) * 1000;

            if (!isNaN(longitude) && !isNaN(latitude)) {
                filter["location.coordinates"] = {
                    $near: {
                        $geometry: {
                            type: "Point",
                            coordinates: [longitude, latitude]
                        },
                        $maxDistance: maxMeters
                    }
                };
            }
        }

        if (warehouseName) {
            filter.warehouseName = (warehouseName as string).trim();
        }

        if (ngoId) {
            filter.ngoId = (ngoId as string).trim();
        }

        if (resourceId) {
            if (!mongoose.Types.ObjectId.isValid(resourceId as string)) {
                return res.status(400).json({
                    status: "failed",
                    message: "Invalid resourceId format."
                });
            }
            filter.resourceId = resourceId;
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
            Inventory.countDocuments(filter)
        ]);

        return res.status(200).json({
            status: "success",
            message: "Nearby inventory retrieved successfully.",
            data: inventoryItems,
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

    try {
        const { inventoryId, requestingNgoId, quantity, performedBy, notes } = req.body;

        // 1. Basic Input Validation
        if (!inventoryId || !requestingNgoId || !quantity || !performedBy) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "inventoryId, requestingNgoId, quantity, and performedBy are required."
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

        // 2. Fetch inventory record inside Mongoose session
        const inventory = await Inventory.findById(inventoryId).session(session);

        if (!inventory) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({
                status: "failed",
                message: `Inventory document with ID ${inventoryId} not found.`
            });
        }

        const isOwnerNgo = inventory.ngoId === requestingNgoId;
        const availableQty = Math.max(0, inventory.totalQuantity - inventory.reservedQuantity);

        let dispatchAmount = 0;
        let decrementReserved = 0;

        // 3. Strict Unreserved-First Allocation Guard
        if (availableQty >= quantity) {
            // CASE 1: Unreserved stock is enough -> ANY NGO (owner or non-owner) takes from unreserved stock!
            dispatchAmount = quantity;
            decrementReserved = 0; // Reserved stock is untouched
        } else if (isOwnerNgo) {
            // CASE 2: Requested quantity exceeds unreserved stock AND requester is OWNER NGO
            // Cap dispatch to total physical stock available in warehouse
            dispatchAmount = Math.min(quantity, inventory.totalQuantity);

            if (dispatchAmount === 0) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({
                    status: "failed",
                    message: "Warehouse is completely out of stock."
                });
            }

            // Consume all remaining unreserved stock first, then take the deficit from reserved
            decrementReserved = dispatchAmount - availableQty;
        } else {
            // Case C: Outside NGO and requestedQty > availableQty -> Cap dispatch to availableQty only!
            if (availableQty === 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(403).json({
                status: "failed",
                    message: `Access denied. Unreserved stock is 0. The remaining ${inventory.reservedQuantity} reserved units belong exclusively to NGO "${inventory.ngoId}".`
            });
            }
            // Cap dispatch amount to availableQty
            dispatchAmount = availableQty;
            decrementReserved = 0;
        }

        // 4. Perform Atomic Database Update
        const updatedInventory = await Inventory.findOneAndUpdate(
            {
                _id: inventoryId,
                totalQuantity: { $gte: dispatchAmount },
                reservedQuantity: { $gte: decrementReserved }
            },
            {
                $inc: {
                    totalQuantity: -dispatchAmount,
                    reservedQuantity: -decrementReserved
                }
            },
            { returnDocument: "after", session, runValidators: true }
        );

        if (!updatedInventory) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                status: "failed",
                message: "Stock dispatch failed due to concurrent update conflicts."
            });
        }

        // 5. Record Audit Ledger Entry
        await InventoryLedger.create(
            [
                {
                    inventoryId: updatedInventory._id,
                    resourceId: updatedInventory.resourceId,
                    action: "DISPATCH",
                    quantity: -dispatchAmount,
                    performedBy: performedBy.trim(),
                    notes: notes
                        ? notes.trim()
                        : `Dispatched ${dispatchAmount} units (${decrementReserved} drawn from reserved) to NGO ${requestingNgoId} from warehouse ${updatedInventory.warehouseName}`
                }
            ],
            { session }
        );

        // 6. Commit DB Transaction
        await session.commitTransaction();
        session.endSession();

        // 7. Synchronize Redis Caches
        const inventoryIdStr = updatedInventory._id.toString();
        const resourceIdStr = updatedInventory.resourceId.toString();
        const newAvailableQty = Math.max(0, updatedInventory.totalQuantity - updatedInventory.reservedQuantity);

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
            safeRedis.decrBy(RedisKeys.resourceGlobalAvailableCount(resourceIdStr), dispatchAmount)
        ]);

        return res.status(200).json({
            status: "success",
            message: `Successfully dispatched ${dispatchAmount} units.`,
            data: {
                inventoryId: updatedInventory._id,
                warehouseName: updatedInventory.warehouseName,
                dispatchedQuantity: dispatchAmount,
                clearedReservedQuantity: decrementReserved,
                totalQuantity: updatedInventory.totalQuantity,
                reservedQuantity: updatedInventory.reservedQuantity,
                availableQuantity: newAvailableQty
            }
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error in dispatchInventory:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while dispatching inventory."
        });
    }
};

export const getInventoryLedger = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { inventoryId } = req.params;
        const { action, page = "1", limit = "20" } = req.query;

        // 1. Validate Inventory ID Format
        if (!inventoryId || !mongoose.Types.ObjectId.isValid(inventoryId.toString())) {
            return res.status(400).json({
                status: "failed",
                message: "Valid inventoryId parameter is required."
            });
        }

        // 2. Verify Inventory Record Exists
        const inventoryExists = await Inventory.exists({ _id: inventoryId });
        if (!inventoryExists) {
            return res.status(404).json({
                status: "failed",
                message: `Inventory document with ID ${inventoryId} not found.`
            });
        }

        // 3. Build Dynamic Query Filter
        const filter: Record<string, any> = { inventoryId };

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