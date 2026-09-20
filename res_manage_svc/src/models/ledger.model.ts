import mongoose, { Schema, Document } from "mongoose";

export interface IInventoryLedger extends Document {
    inventoryId: mongoose.Types.ObjectId;
    resourceId: mongoose.Types.ObjectId;
    action: "RESTOCK" | "RESERVE" | "DISPATCH" | "CANCEL_RESERVATION" | "ADJUSTMENT";
    quantity: number;
    referenceId?: string; // e.g., Allocation ID or NGO Request ID from allocation_svc
    performedBy: string;  // User ID, NGO ID, or System Agent
    notes?: string;
    createdAt: Date;
}

const InventoryLedgerSchema: Schema = new Schema<IInventoryLedger>(
    {
        inventoryId: { type: Schema.Types.ObjectId, ref: "Inventory", required: true, index: true },
        resourceId: { type: Schema.Types.ObjectId, ref: "Resource", required: true },
        action: {
            type: String,
            required: true,
            enum: ["RESTOCK", "RESERVE", "DISPATCH", "CANCEL_RESERVATION", "ADJUSTMENT"]
        },
        quantity: { type: Number, required: true },
        referenceId: { type: String, trim: true, index: true },
        performedBy: { type: String, required: true },
        notes: { type: String, trim: true }
    },
    { timestamps: { createdAt: true, updatedAt: false } } // Immutable logs (only createdAt)
);

export const InventoryLedger = mongoose.model<IInventoryLedger>("InventoryLedger", InventoryLedgerSchema);