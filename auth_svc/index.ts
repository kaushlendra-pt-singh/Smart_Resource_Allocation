import v8 from "node:v8";
if (!(v8 as any).startupSnapshot) {
  (v8 as any).startupSnapshot = { isBuildingSnapshot: () => false };
}

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import app from "./src/app.ts";
import connectToDB from "./src/config/db.ts";
import { connectRedis } from "./src/config/redis.ts";

await connectToDB();
await connectRedis();

const port = process.env.PORT! || 8000;
app.listen(port, async () => {
  console.log(`Auth Server running on port ${port}`);
});