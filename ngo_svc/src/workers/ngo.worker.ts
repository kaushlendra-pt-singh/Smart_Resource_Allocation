import { Worker, Job } from "bullmq";
import { redisConnectionOptions } from "../config/redis";
import { BULK_NGO_VERIFICATION_QUEUE, BULK_NGO_DELETION_QUEUE } from "../queues/ngo.queue";
import ngoModel from "../models/ngo.model";
import { safeRedis } from "../config/redis";
import { RedisKeys } from "../utils/redisKeys";
import axios from "axios";

const internalHeaders = () => ({ "x-internal-key": process.env.INTERNAL_API_KEY });

interface BulkVerificationPayload {
    ngoIds: string[];
    status: "APPROVED" | "REJECTED";
    adminUserId: string;
}

// Same rules as verifyNGOController: only PENDING NGOs are processed, and on approval the
// founder is promoted in auth_svc FIRST (an NGO is never APPROVED while its founder isn't an admin).
export const bulkNgoVerificationWorker = new Worker(
    BULK_NGO_VERIFICATION_QUEUE,
    async (job: Job<BulkVerificationPayload>) => {
        const { ngoIds, status } = job.data;
        console.log(`[Worker] Starting batch verification for ${ngoIds.length} NGOs. Target Status: ${status}`);

        let processedCount = 0;
        const skipped: { ngoId: string; reason: string }[] = [];

        for (const ngoId of ngoIds) {
            try {
                const ngo = await ngoModel.findById(ngoId);
                if (!ngo) {
                    skipped.push({ ngoId, reason: "not found" });
                    continue;
                }
                if (ngo.verificationStatus !== "PENDING") {
                    skipped.push({ ngoId, reason: `already ${ngo.verificationStatus}` });
                    continue;
                }

                if (status === "APPROVED") {
                    try {
                        await axios.patch(
                            `${process.env.AUTH_SERVICE_URL}/api/auth/internal/promote-founder`,
                            { userId: ngo.adminId, ngoId: ngo._id },
                            { headers: internalHeaders(), timeout: 8000 }
                        );
                    } catch (authErr: any) {
                        skipped.push({ ngoId, reason: authErr.response?.data?.message || authErr.message });
                        continue;
                    }

                    if (!ngo.ngoAdmins.some((id) => id.toString() === ngo.adminId.toString())) {
                        ngo.ngoAdmins.push(ngo.adminId);
                    }
                }

                ngo.verificationStatus = status;
                await ngo.save();

                await safeRedis.set(RedisKeys.ngoDetails(ngoId), JSON.stringify(ngo.toObject()), { EX: 86400 });
                await safeRedis.decr(RedisKeys.pendingNgoCount());

                if (status === "APPROVED" && ngo.location?.coordinates) {
                    const [lng, lat] = ngo.location.coordinates;
                    await safeRedis.geoAdd(RedisKeys.ngoLocations(), lng, lat, ngoId);
                } else if (status === "REJECTED") {
                    await safeRedis.zrem(RedisKeys.ngoLocations(), ngoId);
                }

                processedCount++;
            } catch (err) {
                console.error(`[Worker] Failed to verify NGO ${ngoId}:`, err);
                skipped.push({ ngoId, reason: "internal error" });
            }
        }

        console.log(
            `[Worker] Batch verification finished. Processed ${processedCount}/${ngoIds.length} NGOs.`,
            skipped.length ? { skipped } : ""
        );
        return { processedCount, skipped };
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

                // 2. Cascade Sync with auth_svc FIRST (same fail-fast rule as deleteNgoController):
                //    never delete the NGO while users still carry it in joinedNGOs / ngoId.
                try {
                    await axios.post(
                        `${process.env.AUTH_SERVICE_URL}/api/auth/internal/ngos/cleanup-deleted-ngo`,
                        { ngoId, memberIds: allMemberIds },
                        { headers: internalHeaders(), timeout: 8000 }
                    );
                } catch (authError: any) {
                    console.error(
                        `[Worker] Skipping NGO ${ngoId}: auth_svc cleanup failed:`,
                        authError.response?.data?.message || authError.message
                    );
                    continue;
                }

                // 3. Delete from MongoDB
                await ngoModel.findByIdAndDelete(ngoId);

                // 4. Purge Redis Cache
                await safeRedis.del(RedisKeys.ngoDetails(ngoId));
                await safeRedis.zrem(RedisKeys.ngoLocations(), ngoId);
                if (ngoDoc.verificationStatus === "PENDING") {
                    await safeRedis.decr(RedisKeys.pendingNgoCount());
                }
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
