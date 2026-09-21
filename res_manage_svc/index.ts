import dotenv from "dotenv";
dotenv.config();

import app from "./src/app";
import connectToDB from "./src/config/db";
import { connectRedis, redisClient } from "./src/config/redis";
import mongoose from "mongoose";

await connectToDB();
await connectRedis();

const PORT = process.env.PORT || 8002;
const server = app.listen(PORT, () => {
    console.log(`🚀 Resource Management Service running on port ${PORT}`);
});

let isShuttingDown = false;

const gracefulShutdownAPI = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n⚠️ [index.ts] Received ${signal}. Shutting down HTTP server...`);

    const forceExitTimer = setTimeout(() => {
        console.error("❌ Shutdown timed out! Forcing exit...");
        process.exit(1);
    }, 10000);

    try {
        await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
        console.log("HTTP server closed.");

        if (redisClient.isOpen) await redisClient.quit();
        if (mongoose.connection.readyState !== 0) await mongoose.connection.close();

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