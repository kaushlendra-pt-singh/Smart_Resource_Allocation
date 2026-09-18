import { bulkUserDeletionWorker } from "./src/workers/auth.worker.ts";
import { redisClient } from "./src/config/redis.ts";
import mongoose from "mongoose";

console.log("⚡ Background Worker Service started...");

// Function to handle clean exit
const gracefulShutdown = async (signal: string) => {
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

        console.log("✅ Graceful shutdown completed. Exiting process.");
        process.exit(0);
    } catch (error) {
        console.error("❌ Error during graceful shutdown:", error);
        process.exit(1);
    }
};

// Listen for OS termination signals
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));