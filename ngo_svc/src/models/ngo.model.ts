import mongoose, { Schema, Document } from 'mongoose';

// TS Interface representing the NGO Document
export interface INGO extends Document {
  name: string;
  registrationNumber: string; // Official legal/gov registration ID
  adminId: mongoose.Types.ObjectId; // Links back to the NGO_ADMIN who created it
  location: {
    address: string;
    coordinates: [number, number]; // [longitude, latitude] for geospatial filtering
  };
  verificationStatus: 'PENDING' | 'APPROVED' | 'REJECTED'; // Handled by SUPER_ADMIN
  createdAt: Date;
  updatedAt: Date;
}

const NGOSchema: Schema = new Schema<INGO>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    registrationNumber: { type: String, required: true, unique: true, trim: true },
    adminId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    location: {
      address: { type: String, required: true },
      coordinates: {
        type: [Number], // Always remember: [longitude, latitude] ordering in GeoJSON
        required: true,
      },
    },
    verificationStatus: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
    },
  },
  {
    timestamps: true
  }
);

// Enable geo-spatial queries (crucial for local resource allocation tasks later)
NGOSchema.index({ 'location.coordinates': '2dsphere' });

// 1. Enforce GeoJSON coordinate array parsing
NGOSchema.pre<INGO>("save", function () {
  if (this.location && this.location.coordinates) {
    this.location.coordinates = [
      Number(this.location.coordinates[0]),
      Number(this.location.coordinates[1])
    ];
  }
});

// 2. Prevent unique key duplicate bypasses via casing changes
NGOSchema.pre<INGO>("save", function () {
  if (this.isModified("name")) {
    this.name = this.name
      .trim()
      .replace(/\s+/g, " "); // <-- Replaces any sequence of multiple spaces/tabs with a single space
  }

  if (this.isModified("registrationNumber")) {
    this.registrationNumber = this.registrationNumber
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ""); // <-- NGOs usually have no spaces in official ID numbers, strip them entirely!
  }
});

const ngoModel = mongoose.model<INGO>('NGO', NGOSchema);
export default ngoModel;