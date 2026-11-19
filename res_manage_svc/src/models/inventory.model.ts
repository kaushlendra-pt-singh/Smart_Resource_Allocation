import mongoose, { Schema, Document } from "mongoose";

export interface IInventory extends Document {
    ngoId: string;
    resourceId: mongoose.Types.ObjectId;
    warehouseName: string;
    location: {
        address?: string;
        city: string;
        state: string;
        coordinates: [number, number]; // [longitude, latitude]
    };
    totalQuantity: number;      // physical stock in the warehouse
    reservedQuantity: number;   // minimum stock PROTECTED FOR THE OWNER NGO (set by owner, not by allocations)
    allocatedQuantity: number;  // units currently held by active allocations (reserve/cancel/dispatch move this)
    availableQuantity: number;      // Virtual: stock other NGOs can use = total - allocated - reserved
    ownerAvailableQuantity: number; // Virtual: stock the owner tier can use = total - allocated
    expiryDate?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const InventorySchema: Schema = new Schema<IInventory>(
    {
        ngoId: { type: String, required: true, index: true },
        resourceId: {
            type: Schema.Types.ObjectId,
            ref: "Resource",
            required: true,
            index: true
        },
        warehouseName: { type: String, required: true, trim: true },
        location: {
            address: { type: String, trim: true },
            city: { type: String, required: true, trim: true },
            state: { type: String, required: true, trim: true },
            coordinates: { required: true, type: [Number], index: "2dsphere" }
        },
        totalQuantity: { type: Number, required: true, min: 0, default: 0 },
        reservedQuantity: { type: Number, required: true, min: 0, default: 0 },
        allocatedQuantity: { type: Number, required: true, min: 0, default: 0 },
        expiryDate: { type: Date }
    },
    { timestamps: true }
);

// A resource is listed once per warehouse per NGO
InventorySchema.index({ ngoId: 1, resourceId: 1, warehouseName: 1 }, { unique: true });

InventorySchema.virtual("availableQuantity").get(function (this: IInventory) {
    return Math.max(0, this.totalQuantity - this.allocatedQuantity - this.reservedQuantity);
});

InventorySchema.virtual("ownerAvailableQuantity").get(function (this: IInventory) {
    return Math.max(0, this.totalQuantity - this.allocatedQuantity);
});

InventorySchema.set("toJSON", { virtuals: true });
InventorySchema.set("toObject", { virtuals: true });

export const Inventory = mongoose.model<IInventory>("Inventory", InventorySchema);