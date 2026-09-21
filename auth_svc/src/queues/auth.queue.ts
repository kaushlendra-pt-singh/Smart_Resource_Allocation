import { Queue } from "bullmq";
import { redisConnectionOptions } from "../config/redis";

export const BULK_USER_DELETION_QUEUE = "bulk-user-deletion-queue";

export const bulkUserDeletionQueue = new Queue(BULK_USER_DELETION_QUEUE, {
    connection: redisConnectionOptions,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 }
    }
});