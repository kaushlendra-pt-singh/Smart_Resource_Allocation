import mongoose, { Schema, Document } from 'mongoose';

// Define the available roles in the system
export type UserRole = 'SUPER_ADMIN' | 'NGO_ADMIN' | 'GROUND_WORKER' | 'RESIDENT';

// TS Interface representing the User Document
export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  phone: string;
  role: UserRole;
  ngoId: mongoose.Types.ObjectId | null; // Null for SUPER_ADMIN & standalone RESIDENTs
  isVerified: boolean;                   // For NGO workers requiring admin approval
  isActive: boolean;                     // For account suspension/security
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema: Schema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    phone: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ['SUPER_ADMIN', 'NGO_ADMIN', 'GROUND_WORKER', 'RESIDENT'],
      required: true,
    },
    ngoId: {
      type: Schema.Types.ObjectId,
      ref: 'NGO',
      default: null,
    },
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { 
    timestamps: true 
  }
);

// Indexes for high-throughput queries
UserSchema.index({ email: 1 });
UserSchema.index({ ngoId: 1 });

export const User = mongoose.model<IUser>('User', UserSchema);