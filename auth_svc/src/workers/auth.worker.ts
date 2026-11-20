import { Worker, Job } from "bullmq";
import { redisConnectionOptions } from "../config/redis";
import { BULK_USER_DELETION_QUEUE } from "../queues/auth.queue";
import { userModel } from "../models/user.model";
import { safeRedis } from "../config/redis";
import { RedisKeys } from "../utils/redisKeys";
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
                        `${process.env.NGO_SERVICE_URL}/api/ngo/internal/users/${userId}/cleanup`,
                        { headers: { "x-internal-key": process.env.INTERNAL_API_KEY }, timeout: 8000 }
                    );
                } catch (ngoErr: any) {
                    // ngo_svc refuses to delete an NGO founder: skip that user instead of orphaning the NGO
                    console.error(
                        `[Worker] Skipping user ${userId}: ngo_svc cleanup failed:`,
                        ngoErr.response?.data?.message || ngoErr.message
                    );
                    continue;
                }

                // 2. Remove user from MongoDB
                await userModel.findByIdAndDelete(userId);

                // 3. Purge user cache from Redis
                await safeRedis.del([RedisKeys.userProfile(userId), RedisKeys.userRefreshToken(userId)]);
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