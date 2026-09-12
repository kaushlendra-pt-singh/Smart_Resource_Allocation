import { Worker, Job } from "bullmq";
import { redisConnectionOptions } from "../config/redis.ts";
import { BULK_USER_DELETION_QUEUE } from "../queues/auth.queue.ts";
import { userModel } from "../models/user.model.ts";
import { safeRedis } from "../config/redis.ts";
import { RedisKeys } from "../utils/redisKeys.ts";
import axios from "axios";

interface BulkUserDeletionPayload {
    userIds: string[];
    adminUserId: string;
}

export const bulkUserDeletionWorker = new Worker(
    BULK_USER_DELETION_QUEUE,
    async (job: Job<BulkUserDeletionPayload>) => {
        const { userIds } = job.data;
        console.log(`[Worker] Starting batch deletion for ${userIds.length} users.`);

        let deletedCount = 0;

        for (const userId of userIds) {
            try {
                // 1. Cascade cleanup call to ngo_svc to strip user from memberships/admin roles
                try {
                    await axios.delete(
                        `${process.env.NGO_SERVICE_URL}/internal/users/${userId}/cleanup`,
                        { headers: { "x-interservice-token": process.env.INTERNAL_API_KEY } }
                    );
                } catch (ngoErr: any) {
                    console.error(`[Worker] Failed to cascade delete user ${userId} in ngo_svc:`, ngoErr.message);
                }

                // 2. Remove user from MongoDB
                await userModel.findByIdAndDelete(userId);

                // 3. Purge user cache from Redis
                await safeRedis.del(RedisKeys.userProfile(userId));
                deletedCount++;

            } catch (err) {
                console.error(`[Worker] Error deleting user ${userId}:`, err);
            }
        }

        console.log(`[Worker] Batch user deletion completed. Removed ${deletedCount}/${userIds.length} users.`);
        return { deletedCount };
    },
    { connection: redisConnectionOptions }
);

bulkUserDeletionWorker.on("failed", (job, err) => {
    console.error(`[Worker Error] Bulk user deletion job ${job?.id} failed:`, err);
});