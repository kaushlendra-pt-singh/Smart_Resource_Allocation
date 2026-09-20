/*

2. Inventory & Stock Management Controllers (inventory.controller.ts)
Manages physical warehouse stock, restocking, and manual stock updates.

restockInventory

Method / Route: POST /api/v1/inventory/restock

Role: Admin / Warehouse Manager

Description: Increases totalQuantity for a specific resource at a warehouse. Uses a Mongoose session to atomically update inventory and record a RESTOCK entry in InventoryLedger.

getInventoryByLocation

Method / Route: GET /api/v1/inventory

Role: Authenticated Users

Description: Queries available stock across warehouses. Supports filtering by city, state, or resourceId.

dispatchInventory

Method / Route: POST /api/v1/inventory/dispatch

Role: Admin / Warehouse Manager

Description: Called when physical items leave the warehouse. Reduces both reservedQuantity and totalQuantity atomically and writes a DISPATCH ledger record.

3. Internal Inter-Service Controllers (reservation.controller.ts)
Protected by x-interservice-token middleware. Called directly by allocation_svc (Python) during automated resource matching.

reserveStockInternal

Method / Route: POST /internal/inventory/reserve

Role: Internal Service (allocation_svc)

Description: Atomically checks if (totalQuantity - reservedQuantity) >= requestedQty and increments reservedQuantity. Creates a RESERVE ledger entry linked to referenceId (NGO Request ID).

cancelReservationInternal

Method / Route: POST /internal/inventory/cancel-reservation

Role: Internal Service (allocation_svc)

Description: Releases locked stock if an NGO request is canceled or times out. Decrements reservedQuantity and creates a CANCEL_RESERVATION ledger entry.

4. Audit & Ledger Controllers (ledger.controller.ts)
Provides tracking and historical auditing for compliance.

getInventoryLedger

Method / Route: GET /api/v1/inventory/ledger/:inventoryId

Role: Admin

Description: Retrieves the complete immutable audit trail (RESTOCK, RESERVE, DISPATCH, CANCEL) for a specific warehouse inventory record.
 */

const ALLOWED_CATEGORIES = ["FOOD", "MEDICAL", "SHELTER", "CLOTHING", "WATER", "OTHER"];
const ALLOWED_UNITS = ["KG", "LITERS", "BOXES", "UNITS", "PACKETS"];


import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Inventory } from "../models/inventory.model";
import { InventoryLedger } from "../models/ledger.model";
import { Resource } from "../models/resource.model";
import { safeRedis } from "../config/redis";
import { RedisKeys } from "../utils/redisKeys";
import { tryCatch } from "bullmq";

export const createResource = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { name, category, unit, desc, perishable } = req.body;

        if (!name || !category || !unit) {
            return res.status(400).json({
                message: "Name, category, and unit are required.",
                status: "failed"
            });
        }

        const normalizedCategory = category.trim().toUpperCase();
        const normalizedUnit = unit.trim().toUpperCase();

        // Validate Category Enum
        if (!ALLOWED_CATEGORIES.includes(normalizedCategory)) {
            return res.status(400).json({
                message: `Invalid category. Must be one of: ${ALLOWED_CATEGORIES.join(", ")}`,
                status: "failed"
            });
        }

        // Validate Unit Enum
        if (!ALLOWED_UNITS.includes(normalizedUnit)) {
            return res.status(400).json({
                message: `Invalid unit. Must be one of: ${ALLOWED_UNITS.join(", ")}`,
                status: "failed"
            });
        }

        const normalizedName = name.trim();

        // Duplicate check
        const nameExists = await Resource.findOne({ name: normalizedName });
        if (nameExists) {
            return res.status(409).json({
                message: `Resource "${normalizedName}" already exists.`,
                status: "failed"
            });
        }

        // Create resource
        const resource = await Resource.create({
            name: normalizedName,
            category: normalizedCategory,
            unit: normalizedUnit,
            description: desc ? desc.trim() : "No description given",
            isPerishable: perishable ?? false
        });

        // Set in Redis
        await safeRedis.set(
            RedisKeys.resourceDetails(resource._id.toString()),
            JSON.stringify(resource.toObject()),
            { EX: 86400 }
        );

        return res.status(201).json({
            data: resource,
            message: "Resource created successfully.",
            status: "success"
        });
    } catch (e) {
        console.error("Error in createResource:", e);
        return res.status(500).json({
            message: "Internal server error while creating resource.",
            status: "failed"
        });
    }
};

export const getAllResources = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { category, search, page = "1", limit = "10" } = req.query;

        // Build search & filter object dynamically
        const filter: Record<string, any> = {};

        if (category) {
            filter.category = (category as string).trim().toUpperCase();
        }

        if (search) {
            filter.name = { $regex: (search as string).trim(), $options: "i" }; // Case-insensitive fuzzy search
        }

        const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
        const limitNum = Math.max(1, parseInt(limit as string, 10) || 10);
        const skip = (pageNum - 1) * limitNum;

        // Query database with pagination
        const [resources, totalCount] = await Promise.all([
            Resource.find(filter)
                .sort({ name: 1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            Resource.countDocuments(filter)
        ]);

        return res.status(200).json({
            status: "success",
            message: "Resources retrieved successfully.",
            data: resources,
            pagination: {
                totalItems: totalCount,
                currentPage: pageNum,
                totalPages: Math.ceil(totalCount / limitNum),
                pageSize: limitNum
            }
        });
    } catch (error) {
        console.error("Error in getAllResources:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while fetching resources."
        });
    }
};

export const getResourceById = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { resourceId } = req.params;

        if (!resourceId || Array.isArray(resourceId)) {
            return res.status(400).json({
                message: "Resource ID must be a single string and is required.",
                status: "failed"
            });
        }

        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(resourceId)) {
            return res.status(400).json({
                message: "Invalid Resource ID format.",
                status: "failed"
            });
        }

        // 1. Fetch Resource Catalog details (Try Redis Cache first)
        let resourceData: any = null;
        const cachedResource = await safeRedis.get(RedisKeys.resourceDetails(resourceId));

        if (cachedResource) {
            resourceData = JSON.parse(cachedResource);
        } else {
            resourceData = await Resource.findById(resourceId).lean();

            if (!resourceData) {
                return res.status(404).json({
                    message: `Resource with ID ${resourceId} not found.`,
                    status: "failed"
                });
            }

            // Cache resource details in Redis for 24 hours
            await safeRedis.set(
                RedisKeys.resourceDetails(resourceId),
                JSON.stringify(resourceData),
                { EX: 86400 }
            );
        }

        // 2. Fetch stock distribution across all warehouses for this resource
        // Note: Inventory contains virtual 'availableQuantity'
        const inventories = await Inventory.find({ resourceId }).lean({ virtuals: true });

        // 3. Compute global aggregate stock totals across all warehouses
        const stockSummary = inventories.reduce(
            (acc, inv) => {
                acc.totalQuantity += inv.totalQuantity || 0;
                acc.reservedQuantity += inv.reservedQuantity || 0;
                acc.availableQuantity += inv.availableQuantity || 0;
                return acc;
            },
            { totalQuantity: 0, reservedQuantity: 0, availableQuantity: 0 }
        );

        return res.status(200).json({
            status: "success",
            message: "Resource details retrieved successfully.",
            data: {
                resource: resourceData,
                stockSummary,
                warehouses: inventories
            }
        });
    } catch (error) {
        console.error(`Error in getResourceById [ID: ${req.params.resourceId}]:`, error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error while fetching resource details."
        });
    }
};