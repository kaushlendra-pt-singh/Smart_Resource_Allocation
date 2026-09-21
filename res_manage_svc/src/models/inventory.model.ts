import mongoose, { Schema, Document } from "mongoose";

export interface IInventory extends Document {
    ngoId: string;
    resourceId: mongoose.Types.ObjectId;
    warehouseName: string;
    location: {
        city: string;
        state: string;
        coordinates?: [number, number]; // [longitude, latitude] for geographical spatial queries
    };
    totalQuantity: number;
    reservedQuantity: number;
    availableQuantity: number; // Virtual / calculated
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
            city: { type: String, required: true, trim: true },
            state: { type: String, required: true, trim: true },
            coordinates: { type: [Number], index: "2dsphere" } // Optional geospatial indexing for location algorithms
        },
        totalQuantity: { type: Number, required: true, min: 0, default: 0 },
        reservedQuantity: { type: Number, required: true, min: 0, default: 0 },
        expiryDate: { type: Date }
    },
    { timestamps: true }
);

// Compound index to ensure a resource is listed once per warehouse location
InventorySchema.index({ ngoId: 1, resourceId: 1, warehouseName: 1 }, { unique: true });

// Virtual field to get real-time available quantity safely
InventorySchema.virtual("availableQuantity").get(function (this: IInventory) {
    return Math.max(0, this.totalQuantity - this.reservedQuantity);
});

// Ensure virtuals are serialized in JSON responses
InventorySchema.set("toJSON", { virtuals: true });
InventorySchema.set("toObject", { virtuals: true });

export const Inventory = mongoose.model<IInventory>("Inventory", InventorySchema);