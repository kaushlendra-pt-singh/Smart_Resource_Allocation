import { bulkUserDeletionWorker } from "./src/workers/auth.worker";
import { redisClient } from "./src/config/redis";
import mongoose from "mongoose";

console.log("⚡ Background Worker Service started...");
let isShuttingDown = false;

// Function to handle clean exit
const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n⚠️ Received ${signal}. Initiating graceful shutdown...`);

    const forceExitTimer = setTimeout(() => {
        console.error("❌ Worker shutdown timed out! Forcing exit...");
        process.exit(1);
    }, 10000);
    console.log(`\n⚠️ Received ${signal}. Initiating graceful shutdown...`);

    try {
        // 1. Stop workers from picking up NEW jobs and wait for active jobs to finish
        console.log("Closing BullMQ workers...");
        await bulkUserDeletionWorker.close();

        // 2. Close Redis client connection
        console.log("Closing Redis connection...");
        await redisClient.quit();

        // 3. Close MongoDB connection
        console.log("Closing MongoDB connection...");
        await mongoose.connection.close();

        clearTimeout(forceExitTimer);
        console.log("✅ Graceful shutdown completed. Exiting process.");
        process.exit(0);
    } catch (error) {
        console.error("❌ Error during graceful shutdown:", error);
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
};

// Listen for OS termination signals
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));