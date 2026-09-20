import mongoose, { Schema, Document } from "mongoose";

export interface IResource extends Document {
    name: string;
    category: "FOOD" | "MEDICAL" | "SHELTER" | "CLOTHING" | "WATER" | "OTHER";
    unit: "KG" | "LITERS" | "BOXES" | "UNITS" | "PACKETS";
    description?: string;
    isPerishable: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const ResourceSchema: Schema = new Schema<IResource>(
    {
        name: { type: String, required: true, trim: true, unique: true },
        category: {
            type: String,
            required: true,
            enum: ["FOOD", "MEDICAL", "SHELTER", "CLOTHING", "WATER", "OTHER"],
            index: true
        },
        unit: {
            type: String,
            required: true,
            enum: ["KG", "LITERS", "BOXES", "UNITS", "PACKETS"]
        },
        description: { type: String, trim: true },
        isPerishable: { type: Boolean, default: false }
    },
    { timestamps: true }
);

export const Resource = mongoose.model<IResource>("Resource", ResourceSchema);