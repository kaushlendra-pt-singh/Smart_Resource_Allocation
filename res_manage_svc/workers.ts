import dotenv from "dotenv";
dotenv.config();

import connectToDB from "./src/config/db.ts";
import { connectRedis, redisClient } from "./src/config/redis.ts";
import mongoose from "mongoose";

await connectToDB();
await connectRedis();

console.log("⚡ Resource Service Worker started...");

let isShuttingDown = false;

const gracefulShutdownWorker = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n⚠️ [worker.ts] Received ${signal}. Shutting down worker...`);

    const forceExitTimer = setTimeout(() => {
        console.error("❌ Worker shutdown timed out! Forcing exit...");
        process.exit(1);
    }, 10000);

    try {
        //imp Place worker.close() handles here as we define queue workers

        if (redisClient.isOpen) await redisClient.quit();
        if (mongoose.connection.readyState !== 0) await mongoose.connection.close();

        clearTimeout(forceExitTimer);
        console.log("✅ Worker graceful shutdown complete.");
        process.exit(0);
    } catch (error) {
        console.error("❌ Error during worker shutdown:", error);
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
};

process.on("SIGINT", () => gracefulShutdownWorker("SIGINT"));
process.on("SIGTERM", () => gracefulShutdownWorker("SIGTERM"));