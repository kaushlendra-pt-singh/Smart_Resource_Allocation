import { Request } from "express";

//.d.ts file is automatically included by bun, so no need to modify ts.config
declare global {
  namespace Express {
    interface Request {
      user?: {
        _id: string;
        role?: string;
        joinedNGOs: string[];
      };
    }
  }
}