import v8 from "node:v8";
if (!(v8 as any).startupSnapshot) {
  (v8 as any).startupSnapshot = { isBuildingSnapshot: () => false };
}

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import app from "./src/app.ts";
import connectToDB from "./src/config/db.ts";
import { connectRedis, redisClient } from "./src/config/redis.ts";
import mongoose from "mongoose";

await connectToDB();
await connectRedis();

const port = process.env.PORT || 8000;
const server = app.listen(port, () => {
  console.log(`NGO Server running on port ${port}`);
});

let isShuttingDown = false;

const gracefulShutdownAPI = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n⚠️ [index.ts] Received ${signal}. Shutting down HTTP server...`);
    
    // Set a force-exit safeguard timer (10s) in case active HTTP sockets refuse to close
    const forceExitTimer = setTimeout(() => {
        console.error("❌ Shutdown timed out! Forcing exit...");
        process.exit(1);
    }, 10000);

    try {
        // 1. Stop taking new HTTP requests
        await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
        console.log("HTTP server closed.");

        // 2. Safely close database connections
        await redisClient.quit();
        console.log("Redis client disconnected.");

        await mongoose.connection.close();
        console.log("MongoDB connection closed.");

        clearTimeout(forceExitTimer);
        console.log("✅ API graceful shutdown complete.");
        process.exit(0);
    } catch (error) {
        console.error("❌ Error during API graceful shutdown:", error);
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
};

process.on("SIGINT", () => gracefulShutdownAPI("SIGINT"));
process.on("SIGTERM", () => gracefulShutdownAPI("SIGTERM"));