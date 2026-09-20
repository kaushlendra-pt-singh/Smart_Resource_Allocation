import { bulkNgoVerificationWorker, bulkNgoDeletionWorker } from "./src/workers/ngo.worker.ts";
import { redisClient } from "./src/config/redis.ts";
import mongoose from "mongoose";

console.log("⚡ Background Worker Service started...");

let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n⚠️ Received ${signal}. Initiating graceful shutdown...`);

    const forceExitTimer = setTimeout(() => {
        console.error("❌ Worker shutdown timed out! Forcing exit...");
        process.exit(1);
    }, 10000);

    try {
        // 1. Stop workers from picking up NEW jobs and wait for active jobs to finish
        console.log("Closing BullMQ workers...");
        await Promise.all([
            bulkNgoVerificationWorker.close(),
            bulkNgoDeletionWorker.close()
        ]);
        console.log("BullMQ workers closed successfully.");

        // 2. Disconnect Redis and MongoDB clients used by worker jobs
        if (redisClient.isOpen) {
            await redisClient.quit();
            console.log("Redis connection closed.");
        }

        if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close();
            console.log("MongoDB connection closed.");
        }

        clearTimeout(forceExitTimer);
        console.log("✅ Graceful worker shutdown completed. Exiting process.");
        process.exit(0);
    } catch (error) {
        console.error("❌ Error during worker graceful shutdown:", error);
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
};

// Listen for OS termination signals
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));