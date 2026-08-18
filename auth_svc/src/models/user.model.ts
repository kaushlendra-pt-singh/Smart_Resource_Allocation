import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

// Define the available roles in the system
export type UserRole = 'SUPER_ADMIN' | 'NGO_ADMIN' | 'GROUND_WORKER' | 'RESIDENT';
export type verificationTypes = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface IJoinedNGO {
    ngoId: mongoose.Types.ObjectId;
    roleInNGO: 'NGO_ADMIN' | 'GROUND_WORKER' | 'VOLUNTEER';
}

// TS Interface representing the User Document
export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  phone: string;
  role: UserRole;
  ngoId: mongoose.Types.ObjectId | null; // Null for SUPER_ADMIN & standalone RESIDENTs
  verificationStatus: verificationTypes; // For NGO workers requiring admin approval
  isActive: boolean;                     // For account suspension/security
  isGoogleUser: boolean;
  joinedNGOs: IJoinedNGO[];
  createdAt: Date;
  updatedAt: Date;
  comparePassword(password: string): Promise<boolean>;
  generateAccessToken(): string;
  generateRefreshToken(): string;
}

const UserSchema: Schema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    phone: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ['SUPER_ADMIN', 'NGO_ADMIN', 'GROUND_WORKER', 'RESIDENT', 'VOLUNTEER'],
      required: true,
      default: 'RESIDENT'
    },
    joinedNGOs: [
        {
            _id: false, // Prevents Mongoose from generating an extra sub-id for every entry
            ngoId: { type: Schema.Types.ObjectId, ref: 'NGO', required: true },
            roleInNGO: { 
                type: String, 
                enum: ['NGO_ADMIN', 'GROUND_WORKER', 'VOLUNTEER'], 
                required: true
            }
        }
    ],
    verificationStatus: {
      type: String,
      enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING'
    },
    isActive: { type: Boolean, default: true },
    isGoogleUser: { type: Boolean, default: false },
  },
  {
    timestamps: true
  }
);

// Indexes for high-throughput queries
UserSchema.index({ ngoId: 1 });

UserSchema.pre<IUser>("save", async function () {
  if (!this.isModified("passwordHash")) {
    return;
  }
  try {
    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
  } catch (error: any) {
    throw new Error(error); // Throwing an error will safely halt the save operation
  }
});

UserSchema.methods.comparePassword = async function (password: string) {
  return await bcrypt.compare(password, this.passwordHash);
}

UserSchema.methods.generateAccessToken = function (this: IUser): string {
    return jwt.sign(
        {
            _id: this._id.toString(),
            email: this.email,
            role: this.role
        },
        process.env.JWT_ACCESS_SECRET!,
        { expiresIn: "45m" }
    );
};

// 2. Concrete Refresh Token Method
UserSchema.methods.generateRefreshToken = function (this: IUser): string {
    return jwt.sign(
        {
            userId: this._id.toString()
        },
        process.env.JWT_REFRESH_SECRET!,
        { expiresIn: "7d" }
    );
};

export const userModel = mongoose.model<IUser>('User', UserSchema);