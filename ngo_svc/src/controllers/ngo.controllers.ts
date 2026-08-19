import ngoModel from "../models/ngo.model.ts";
import type { Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import { safeRedis } from "../config/redis.ts";
import { RedisKeys } from "../utils/redisKeys.ts";
import axios from "axios";

export const registerNGOController = async (req: Request, res: Response): Promise<Response> => {
    try {
        // 1. Extract required fields INCLUDING documentUrl from Cloudinary
        const { name, registrationNumber, location, documentUrl } = req.body;
        const adminId = req.user?._id;

        if (!name || !registrationNumber || !location || !documentUrl) {
            return res.status(400).json({
                status: "failed",
                message: "Please provide all required fields including documentUrl."
            });
        }

        // 2. Prevent duplicate NGO registrations by registration number
        const ngoExists = await ngoModel.findOne({ registrationNumber });
        if (ngoExists) {
            return res.status(422).json({
                status: "failed",
                message: "An NGO with this registration number already exists!"
            });
        }

        // 3. Save NGO with PENDING status and document link
        const ngo = await ngoModel.create({
            name,
            registrationNumber,
            adminId,
            location,
            ngoAdmins: [adminId!],
            registrationDocuments: documentUrl,
            verificationStatus: "PENDING" // Explicit initial state
        });

        await safeRedis.set(RedisKeys.ngoDetails(ngo._id.toString()), JSON.stringify(ngo.toObject()), { EX: 86400 });
        await safeRedis.incr(RedisKeys.pendingNgoCount());

        return res.status(201).json({
            status: "success",
            message: "NGO application submitted successfully. Pending Super Admin approval.",
            ngo
        });

    } catch (error: any) {
        console.error(`Error in ngo register: ${error}`);
        return res.status(500).json({
            status: "failed",
            message: "NGO Registration Failed due to internal server error."
        });
    }
};


cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const getUploadSignatureController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const timestamp = Math.round(new Date().getTime() / 1000);

        // Generate a secure, time-limited signature using your server's private API secret
        const signature = cloudinary.utils.api_sign_request(
            {
                timestamp: timestamp,
                folder: "ngo_verification_docs", // Organize uploads inside a folder
            },
            process.env.CLOUDINARY_API_SECRET!
        );

        return res.status(200).json({
            status: "success",
            signature,
            timestamp,
            cloudName: process.env.CLOUDINARY_CLOUD_NAME,
            apiKey: process.env.CLOUDINARY_API_KEY,
        });
    } catch (error: any) {
        console.error(`Signature Generation Error: ${error}`);
        return res.status(500).json({ message: "Failed to generate upload tokens." });
    }
};

export const getPendingNGOsController = async (req: Request, res: Response): Promise<Response> => {
    try {
        // 1. Parse pagination params with defaults
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 10)); // Cap limit at 100 max
        const skip = (page - 1) * limit;

        // 2. Fetch pending NGOs and total count concurrently
        const query = { verificationStatus: "PENDING" } as const;

        const [pendingNGOs, cachedCount] = await Promise.all([
            ngoModel.find(query)
                .sort({ createdAt: -1 }) // Oldest first or newest first (-1 for newest)
                .skip(skip)
                .limit(limit)
                .lean(),
            safeRedis.get(RedisKeys.pendingNgoCount())
        ]);

        let totalCount: number;
        if (cachedCount === null || cachedCount === undefined) {
            totalCount = await ngoModel.countDocuments(query);
            // Self-healing: Backfill Redis with ground truth
            await safeRedis.set(RedisKeys.pendingNgoCount(), totalCount.toString());
        } else {
            totalCount = parseInt(cachedCount, 10) || 0;
        }

        // 3. Calculate metadata
        const totalPages = Math.ceil(totalCount / limit);

        return res.status(200).json({
            status: "success",
            data: {
                ngos: pendingNGOs,
                pagination: {
                    currentPage: page,
                    totalPages,
                    totalNGOs: Number(totalCount),
                    limit,
                    hasNextPage: page < totalPages,
                    hasPrevPage: page > 1
                }
            }
        });

    } catch (error: any) {
        console.error("Error in getPendingNGOsController:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error fetching pending NGOs."
        });
    }
};

export const verifyNGOController = async (req: Request, res: Response): Promise<Response> => {
    //incomplete yet
    try {
        const { ngoId } = req.params;
        const { status } = req.body; // Expects 'APPROVED' or 'REJECTED'

        // 1. Validate Input
        if (!['APPROVED', 'REJECTED'].includes(status)) {
            return res.status(400).json({
                status: "failed",
                message: "Invalid status. Must be 'APPROVED' or 'REJECTED'."
            });
        }
        if (!ngoId) return res.status(400).json({
            status: "failed",
            message: "No ngoId given."
        });

        const cachedNgoStr = await safeRedis.get(RedisKeys.ngoDetails(ngoId as string));

        if (cachedNgoStr) {
            // 2. Parse string into an object
            const ngoRedis = JSON.parse(cachedNgoStr);

            // 3. Access property on parsed object
            if (ngoRedis.verificationStatus === status) {
                return res.status(400).json({
                    status: "failed",
                    message: `NGO status is already ${status}`
                });
            }
        }

        // 2. Fetch NGO
        const ngo = await ngoModel.findById(ngoId);
        if (!ngo) {
            return res.status(404).json({ status: "failed", message: "NGO not found." });
        }

        // Prevent redundant updates
        const previousStatus = ngo.verificationStatus;
        if (ngo.verificationStatus === status) {
            return res.status(400).json({
                status: "failed",
                message: `NGO is already ${status}.`
            });
        }
        if (previousStatus !== "PENDING") {
            return res.status(400).json({
                status: "failed",
                message: `Cannot change status. NGO has already been processed as ${previousStatus}.`
            });
        }

        // 3. Inter-Service Sync: Call auth_svc FIRST if approving
        if (status === 'APPROVED') {
            try {
                await axios.patch(
                    `${process.env.AUTH_SERVICE_URL}/api/auth/internal/promote-founder`,
                    {
                        userId: ngo.adminId, // The founding user's ID saved during NGO registration
                        ngoId: ngo._id
                    },
                    {
                        headers: {
                            "x-internal-key": process.env.INTERNAL_API_KEY
                        },
                        timeout: 5000 // 5-second timeout to prevent requests from hanging indefinitely
                    }
                );
            } catch (syncError: any) {
                console.error("Failed to sync promotion with auth_svc:", syncError?.response?.data || syncError.message);

                // Return immediately without saving changes to NGO in database
                return res.status(502).json({
                    status: "failed",
                    message: "Failed to promote founder in Auth Service. NGO status was NOT updated."
                });
            }
        }

        // 4. Update In-Memory NGO State & Save ONLY after successful sync or rejection
        ngo.verificationStatus = status;

        if (status === 'APPROVED') {
            const hasFounder = ngo.ngoAdmins.some((id) => id.toString() === ngo.adminId.toString());
            if (!hasFounder) {
                ngo.ngoAdmins.push(ngo.adminId);
            }
        }

        await ngo.save(); // Clean DB write!

        const ngoPlain = ngo.toObject();

        // Cache updated details with 24h TTL
        await safeRedis.set(
            RedisKeys.ngoDetails(ngo._id.toString()),
            JSON.stringify(ngoPlain),
            { EX: 86400 }
        );

        // ONLY decrement pending count if transitioning from PENDING
        if (previousStatus === "PENDING") {
            await safeRedis.decr(RedisKeys.pendingNgoCount());
        }

        // Handle Geospatial Indexing based on status
        if (status === 'APPROVED' && ngo.location?.coordinates) {
            const [longitude, latitude] = ngo.location.coordinates;
            await safeRedis.geoAdd(
                RedisKeys.ngoLocations(),
                longitude,
                latitude,
                ngo._id.toString()
            );
        } else if (status === 'REJECTED') {
            // Remove from Geo set if present
            await safeRedis.zrem(RedisKeys.ngoLocations(), ngo._id.toString());
        }

        return res.status(200).json({
            status: "success",
            message: `NGO status updated to ${status} successfully.`,
            ngo
        });

    } catch (error: any) {
        console.error("Error in verifyNGOController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error verifying NGO." });
    }
};

//This controller will not be used.
export const addCoAdminController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { ngoId } = req.params;
        const { targetUserId } = req.body;
        const requesterRole = req.user?.role;
        const requesterNGOs = req.user?.joinedNGOs || [];

        if (!targetUserId) {
            return res.status(400).json({
                status: "failed",
                message: "targetUserId is required."
            });
        }

        // 1. Authorization Check: Must be SUPER_ADMIN OR an NGO_ADMIN of THIS specific NGO
        const isSuperAdmin = requesterRole === 'SUPER_ADMIN';
        const isNGOAdminOfThisNGO = requesterRole === 'NGO_ADMIN' && requesterNGOs.some((id: any) => id.toString() === String(ngoId));

        if (!isSuperAdmin && !isNGOAdminOfThisNGO) {
            return res.status(403).json({
                status: "failed",
                message: "Access Denied: You are not authorized to add co-admins for this NGO."
            });
        }

        // 2. Ensure NGO exists and is APPROVED
        const ngo = await ngoModel.findById(ngoId);
        if (!ngo) {
            return res.status(404).json({ status: "failed", message: "NGO not found." });
        }
        if (ngo.verificationStatus !== 'APPROVED') {
            return res.status(400).json({
                status: "failed",
                message: "Cannot add co-admins to an unapproved or rejected NGO."
            });
        }

        const isAlreadyCoAdmin = ngo.ngoAdmins.some((id) => id.toString() === targetUserId.toString());
        if (!isAlreadyCoAdmin) {
            ngo.ngoAdmins.push(targetUserId);
            await ngo.save();
        }

        // 3. Inter-Service Call to auth_svc with strict targetUserId
        try {
            await axios.patch(
                `${process.env.AUTH_SERVICE_URL}/api/auth/internal/promote-coadmin`,
                {
                    targetUserId,
                    ngoId: ngo._id
                },
                {
                    headers: {
                        "x-internal-key": process.env.INTERNAL_API_KEY
                    }
                }
            );
        } catch (syncError: any) {
            console.error("Failed to sync co-admin promotion with auth_svc:", syncError);
            return res.status(502).json({
                status: "failed",
                message: "Failed to promote co-admin in Auth Service."
            });
        }

        return res.status(200).json({
            status: "success",
            message: `User (${targetUserId}) added as co-admin successfully.`
        });

    } catch (error: any) {
        console.error("Error in addCoAdminController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error adding co-admin." });
    }
};

export const addMemberController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { ngoId } = req.params;
        const { targetUserId, roleInNGO } = req.body;

        // 1. Input Validation
        if (!ngoId || !targetUserId || !roleInNGO) {
            return res.status(400).json({ status: "failed", message: "ngoId, targetUserId, and roleInNGO are required." });
        }

        const allowedRoles = ["NGO_ADMIN", "GROUND_WORKER", "VOLUNTEER"];
        if (!allowedRoles.includes(roleInNGO)) {
            return res.status(400).json({
                status: "failed",
                message: `Invalid role. Allowed roles are: ${allowedRoles.join(', ')}`
            });
        }

        const currentUserId = req.user!._id.toString();
        const targetUserIdStr = targetUserId.toString();
        const isSuperAdmin = req.user!.role === 'SUPER_ADMIN';

        // Helper function to validate status, authorization, and role conflicts
        const validateNGOState = (ngoDoc: { verificationStatus: string; ngoAdmins: any[]; ngoWorkers: any[] }) => {
            if (ngoDoc.verificationStatus !== "APPROVED") {
                return "NGO is not approved.";
            }

            const isNgoAdmin = ngoDoc.ngoAdmins.some(id => id.toString() === currentUserId);
            if (!isNgoAdmin && !isSuperAdmin) {
                return "Forbidden: You are not an admin of this specific NGO.";
            }

            const isAlreadyAdmin = ngoDoc.ngoAdmins.some(id => id.toString() === targetUserIdStr);
            const isAlreadyWorker = ngoDoc.ngoWorkers.some(id => id.toString() === targetUserIdStr);

            if (roleInNGO === "NGO_ADMIN" && isAlreadyAdmin) {
                return "User is already an Admin of this NGO.";
            }
            if (roleInNGO !== "NGO_ADMIN" && isAlreadyWorker) {
                return `User is already registered as ${roleInNGO}.`;
            }

            return null;
        };

        // 2. REDIS CHECK: Fast Early Exits
        const cachedNgoStr = await safeRedis.get(RedisKeys.ngoDetails(ngoId.toString()));
        if (cachedNgoStr) {
            const cacheError = validateNGOState(JSON.parse(cachedNgoStr));
            if (cacheError) {
                const statusCode = cacheError.startsWith("Forbidden") ? 403 : 400;
                return res.status(statusCode).json({ status: "failed", message: cacheError });
            }
        }

        // 3. MONGO FETCH: Single Source of Truth
        const ngo = await ngoModel.findById(ngoId);
        if (!ngo) {
            return res.status(404).json({ status: "failed", message: "NGO not found." });
        }

        const dbError = validateNGOState(ngo);
        if (dbError) {
            const statusCode = dbError.startsWith("Forbidden") ? 403 : 400;
            return res.status(statusCode).json({ status: "failed", message: dbError });
        }

        // 4. INTER-SERVICE SYNC: Notify Auth Service
        try {
            await axios.patch(
                `${process.env.AUTH_SERVICE_URL}/api/auth/internal/add-joined-ngo`,
                { targetUserId: targetUserIdStr, ngoId: ngo._id, roleInNGO },
                {
                    headers: { "x-internal-key": process.env.INTERNAL_API_KEY },
                    timeout: 8000
                }
            );
        } catch (syncError: any) {
            console.error("Failed to sync with auth_svc:", syncError?.response?.data || syncError.message);
            return res.status(syncError?.response?.status || 502).json({
                status: "failed",
                message: syncError?.response?.data?.message || "Auth Service sync failed."
            });
        }

        // 5. MUTATE ARRAYS: Handle Role Transitions
        if (roleInNGO === "NGO_ADMIN") {
            ngo.ngoAdmins.push(targetUserIdStr as any);
            ngo.ngoWorkers = ngo.ngoWorkers.filter(id => id.toString() !== targetUserIdStr);
        } else {
            ngo.ngoWorkers.push(targetUserIdStr as any);
            ngo.ngoAdmins = ngo.ngoAdmins.filter(id => id.toString() !== targetUserIdStr);
        }

        // 6. SAVE DB & REFRESH REDIS CACHE
        await ngo.save();
        await safeRedis.set(
            RedisKeys.ngoDetails(ngo._id.toString()),
            JSON.stringify(ngo.toObject()),
            { EX: 86400 }
        );

        return res.status(200).json({
            status: "success",
            message: `User successfully updated to ${roleInNGO}.`,
            ngo
        });

    } catch (error) {
        console.error("Error in addMemberController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error." });
    }
};