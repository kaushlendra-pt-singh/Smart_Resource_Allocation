import v8 from "node:v8";
if (!(v8 as any).startupSnapshot) {
  (v8 as any).startupSnapshot = { isBuildingSnapshot: () => false };
}

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import app from "./src/app.ts";
import connectToDB from "./src/config/db.ts";

await connectToDB();

app.listen(8000, async () => {
  console.log("Auth Server running on port 8000");
});