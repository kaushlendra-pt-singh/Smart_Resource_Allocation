import { Queue } from "bullmq";
import { redisConnectionOptions } from "../config/redis.ts";

export const BULK_NGO_VERIFICATION_QUEUE = "bulk-ngo-verification-queue";
export const BULK_NGO_DELETION_QUEUE = "bulk-ngo-deletion-queue";

export const bulkNgoVerificationQueue = new Queue(BULK_NGO_VERIFICATION_QUEUE, {
    connection: redisConnectionOptions,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 }
    }
});

export const bulkNgoDeletionQueue = new Queue(BULK_NGO_DELETION_QUEUE, {
    connection: redisConnectionOptions,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 }
    }
});