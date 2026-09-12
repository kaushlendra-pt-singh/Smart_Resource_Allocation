import mongoose, { Schema, Document } from 'mongoose';

const DEFAULT_PROFILE_PIC = "https://cdn-icons-png.flaticon.com/512/149/149071.png";
const DEFAULT_COVER_IMAGE = "https://images.unsplash.com/photo-1557683316-973673baf926?q=80&w=1200&auto=format&fit=crop";

// TS Interface representing the NGO Document
export interface INGO extends Document {
  name: string;
  registrationNumber: string; // Official legal/gov registration ID
  adminId: mongoose.Types.ObjectId; // Links back to the NGO_ADMIN who created it
  description: string;
  category: string;
  website: string;
  profilePic: string;
  coverImage: string;
  location: {
    address: string;
    type: "Point";
    coordinates: [number, number]; // [longitude, latitude] for geospatial filtering
  };
  license: string;
  regDoc: string;
  documents: [{
    title: string;
    fileUrl: string
  }];
  socialLinks: {
    insta: string;
    twitter: string;
    linkedIn: string;
    yt: string;
  },
  ngoAdmins: mongoose.Types.ObjectId[];
  ngoWorkers: mongoose.Types.ObjectId[];
  verificationStatus: 'PENDING' | 'APPROVED' | 'REJECTED'; // Handled by SUPER_ADMIN
  createdAt: Date;
  updatedAt: Date;
}

const defSocialLinks = {
  insta: "",
  twitter: "",
  linkedIn: "",
  yt: ""
};

const NGOSchema: Schema = new Schema<INGO>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    registrationNumber: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true, default: "" },
    category: { type: String, trim: true, default: "" },
    website: { type: String, trim: true, default: "" },
    profilePic: { type: String, trim: true, default: DEFAULT_PROFILE_PIC },
    coverImage: { type: String, trim: true, default: DEFAULT_COVER_IMAGE },
    adminId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    location: {
      address: { type: String, required: true },
      type: { type: String, enum: ['Point'], default: 'Point', required: true },
      coordinates: {
        type: [Number], // Always remember: [longitude, latitude] ordering in GeoJSON
        required: true,
      },
    },
    license: { type: String, trim: true, required: true },
    regDoc: { type: String, trim: true, required: true },
    documents: [{ type: Object }],
    socialLinks: { type: Object, default: defSocialLinks },
    ngoAdmins: [{ type: Schema.Types.ObjectId, ref: "User", default: [] }],
    ngoWorkers: [{ type: Schema.Types.ObjectId, ref: "User", default: [] }],
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
//Compound index for filtered paginated lists, latest first
NGOSchema.index({ verificationStatus: 1, createdAt: -1 });

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