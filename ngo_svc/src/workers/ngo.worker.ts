import { Worker, Job } from "bullmq";
import { redisConnectionOptions } from "../config/redis.ts";
import { BULK_NGO_VERIFICATION_QUEUE, BULK_NGO_DELETION_QUEUE } from "../queues/ngo.queue.ts";
import ngoModel from "../models/ngo.model.ts";
import { safeRedis } from "../config/redis.ts";
import { RedisKeys } from "../utils/redisKeys.ts";
import axios from "axios";

interface BulkVerificationPayload {
    ngoIds: string[];
    status: "APPROVED" | "REJECTED";
    adminUserId: string;
}

export const bulkNgoVerificationWorker = new Worker(
    BULK_NGO_VERIFICATION_QUEUE,
    async (job: Job<BulkVerificationPayload>) => {
        const { ngoIds, status } = job.data;
        console.log(`[Worker] Starting batch verification for ${ngoIds.length} NGOs. Target Status: ${status}`);

        let approvedCount = 0;

        for (const ngoId of ngoIds) {
            try {
                // 1. Update MongoDB
                const updatedNgo = await ngoModel.findByIdAndUpdate(
                    ngoId,
                    { verificationStatus: status },
                    { new: true }
                );

                if (updatedNgo) {
                    // 2. Refresh Redis Detail Cache
                    await safeRedis.set(
                        RedisKeys.ngoDetails(ngoId),
                        JSON.stringify(updatedNgo.toObject()),
                        { EX: 86400 }
                    );
                    approvedCount++;
                }
            } catch (err) {
                console.error(`[Worker] Failed to verify NGO ${ngoId}:`, err);
            }
        }

        // 3. Update Pending Count in Redis
        if (approvedCount > 0) {
            const currentCount = await safeRedis.get(RedisKeys.pendingNgoCount());
            if (currentCount) {
                const newCount = Math.max(0, parseInt(currentCount) - approvedCount);
                await safeRedis.set(RedisKeys.pendingNgoCount(), newCount.toString());
            }
        }

        console.log(`[Worker] Batch verification finished. Successfully processed ${approvedCount}/${ngoIds.length} NGOs.`);
        return { processedCount: approvedCount };
    },
    { connection: redisConnectionOptions }
);

bulkNgoVerificationWorker.on("failed", (job, err) => {
    console.error(`[Worker Error] Job ${job?.id} failed with error:`, err);
});


interface BulkDeletionPayload {
    ngoIds: string[];
    adminUserId: string;
}

export const bulkNgoDeletionWorker = new Worker(
    BULK_NGO_DELETION_QUEUE,
    async (job: Job<BulkDeletionPayload>) => {
        const { ngoIds } = job.data;
        console.log(`[Worker] Starting batch deletion for ${ngoIds.length} NGOs.`);

        let deletedCount = 0;

        for (const ngoId of ngoIds) {
            try {
                // 1. Fetch NGO to collect all associated member IDs
                const ngoDoc = await ngoModel.findById(ngoId);
                if (!ngoDoc) continue;

                const allMemberIds = Array.from(
                    new Set([
                        ngoDoc.adminId.toString(),
                        ...(ngoDoc.ngoAdmins || []).map((id: any) => id.toString()),
                        ...(ngoDoc.ngoWorkers || []).map((id: any) => id.toString())
                    ])
                );

                // 2. Cascade Sync with auth_svc to strip roles & clear joinedNGOs
                try {
                    await axios.post(
                        `${process.env.AUTH_SERVICE_URL}/internal/ngos/cleanup-deleted-ngo`,
                        { ngoId, memberIds: allMemberIds },
                        { headers: { "x-interservice-token": process.env.INTERNAL_API_KEY } }
                    );
                } catch (authError: any) {
                    console.error(`[Worker] Failed to sync NGO ${ngoId} cleanup with auth_svc:`, authError.message);
                }

                // 3. Delete from MongoDB
                await ngoModel.findByIdAndDelete(ngoId);

                // 4. Purge Redis Cache
                await safeRedis.del(RedisKeys.ngoDetails(ngoId));
                deletedCount++;

            } catch (err) {
                console.error(`[Worker] Error deleting NGO ${ngoId}:`, err);
            }
        }

        console.log(`[Worker] Batch deletion completed. Removed ${deletedCount}/${ngoIds.length} NGOs.`);
        return { deletedCount };
    },
    { connection: redisConnectionOptions }
);

bulkNgoDeletionWorker.on("failed", (job, err) => {
    console.error(`[Worker Error] Bulk deletion job ${job?.id} failed:`, err);
});