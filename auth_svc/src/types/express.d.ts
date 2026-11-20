import { Request } from "express";

//.d.ts file is automatically included by bun, so no need to modify ts.config
declare global {
  namespace Express {
    interface Request {
      user?: {
        _id: string;
        role?: string;
        email: string;
        ngoId?: string | null; // NGO this user owns
        joinedNGOs?: { ngoId: string; roleInNGO: string }[];
        [key: string]: any;
      };
    }
  }
}
