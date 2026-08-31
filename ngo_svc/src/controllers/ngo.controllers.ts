import ngoModel from "../models/ngo.model.ts";
import type { Request, Response } from "express";
import { v2 as cloudinary } from "cloudinary";
import { safeRedis } from "../config/redis.ts";
import { RedisKeys } from "../utils/redisKeys.ts";
import axios from "axios";

/*
deleteNgo
hevent implemented profile and cover images yet.
*/


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

export const getNgoByIdController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { ngoId } = req.params;
        const currentUserId = req.user?._id?.toString();
        const userRole = req.user?.role;
        const isSuperAdmin = userRole === "SUPER_ADMIN";
        if (!ngoId)
            return res.status(400).json({ message: "Ngo Id is required.", status: "failed" });

        // 1. Check Redis Cache First
        let ngoData;
        const cachedNgoStr = await safeRedis.get(RedisKeys.ngoDetails(ngoId.toString()));

        if (cachedNgoStr) {
            ngoData = JSON.parse(cachedNgoStr);
        } else {
            // Fallback to MongoDB
            const ngoDoc = await ngoModel.findById(ngoId);
            if (!ngoDoc) {
                return res.status(404).json({ status: "failed", message: "NGO not found." });
            }
            ngoData = ngoDoc.toObject();

            // Populate Redis Cache
            await safeRedis.set(
                RedisKeys.ngoDetails(ngoId.toString()),
                JSON.stringify(ngoData),
                { EX: 86400 }
            );
        }

        // 2. Authorization Check for Non-Approved NGOs
        if (ngoData.verificationStatus !== "APPROVED") {
            const isNgoAdmin = ngoData.ngoAdmins?.some((id: any) => id.toString() === currentUserId);
            const isNgoWorker = ngoData.ngoWorkers?.some((id: any) => id.toString() === currentUserId);

            // Deny access if user is neither Super Admin nor an NGO member
            if (!isSuperAdmin && !isNgoAdmin && !isNgoWorker) {
                return res.status(403).json({
                    status: "failed",
                    message: "Forbidden: You do not have permission to view this unapproved NGO."
                });
            }
        }

        // 3. Return NGO Data
        return res.status(200).json({
            status: "success",
            data: ngoData
        });

    } catch (error) {
        console.error("Error in getNgoByIdController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error." });
    }
};

export const listNgosController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
        const skip = (page - 1) * limit;

        const { search, status } = req.query;
        const isAdmin = req.user?.role === "SUPER_ADMIN" || req.user?.role === "NGO_ADMIN";

        // Security Guard: Public users are strictly locked to APPROVED
        const filter: Record<string, any> = {
            verificationStatus: (isAdmin && status) ? status : "APPROVED"
        };

        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: "i" } },
                { "location.address": { $regex: search, $options: "i" } }
            ];
        }

        const [ngos, totalNgos] = await Promise.all([
            ngoModel.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            ngoModel.countDocuments(filter)
        ]);

        return res.status(200).json({
            status: "success",
            pagination: {
                totalNgos,
                totalPages: Math.ceil(totalNgos / limit),
                currentPage: page,
                limit
            },
            data: ngos
        });
    } catch (error) {
        console.error("Error listing NGOs:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error." });
    }
};

export const getNgoMembersController = async (req: Request, res: Response): Promise<Response> => {
    try {
        // 1. Extract from req.params (RESTful standard)
        const { ngoId } = req.params;
        const currentUserId = req.user?._id?.toString();
        const isSuperAdmin = req.user?.role === "SUPER_ADMIN";

        if (!ngoId) {
            return res.status(400).json({ status: "failed", message: "NGO ID is required." });
        }

        let ngoData: any;
        const cachedItemStr = await safeRedis.get(RedisKeys.ngoDetails(ngoId.toString()));

        if (cachedItemStr) {
            ngoData = JSON.parse(cachedItemStr);
        } else {
            const dbData = await ngoModel.findById(ngoId);
            if (!dbData) {
                return res.status(404).json({ status: "failed", message: "NGO not found." });
            }

            ngoData = dbData.toObject();
            await safeRedis.set(
                RedisKeys.ngoDetails(ngoId.toString()),
                JSON.stringify(ngoData),
                { EX: 86400 }
            );
        }

        // 2. Extract & stringify member IDs
        const ngoAdmins = (ngoData.ngoAdmins || []).map((id: any) => id.toString());
        const ngoWorkers = (ngoData.ngoWorkers || []).map((id: any) => id.toString());
        const allMembers = [...ngoAdmins, ...ngoWorkers];

        // 3. Authorization Guard: Ensure caller is a member of this NGO or a Super Admin
        const isMember = allMembers.includes(currentUserId || "");
        if (!isSuperAdmin && !isMember) {
            return res.status(403).json({
                status: "failed",
                message: "Forbidden: Only members or Super Admins can view this roster."
            });
        }

        // 4. Return structured response with roles distinguished
        return res.status(200).json({
            status: "success",
            message: "Members fetched successfully.",
            data: {
                ngoAdmins,
                ngoWorkers,
                totalMembers: allMembers.length
            }
        });

    } catch (error) {
        console.error("Error in getNgoMembersController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error fetching members." });
    }
};

export const cleanupDeletedUserController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({ status: "failed", message: "User ID is required." });
        }

        // 1. Prevent deletion if user is the primary Founder/Creator of an NGO
        const foundedNgo = await ngoModel.findOne({ adminId: userId });
        if (foundedNgo) {
            return res.status(400).json({
                status: "failed",
                message: "Cannot delete user: User is the primary founder/admin of an active NGO. Transfer ownership or delete the NGO first."
            });
        }

        // 2. Find all NGOs where the user is an admin or worker
        const affectedNgos = await ngoModel.find({
            $or: [{ ngoAdmins: userId }, { ngoWorkers: userId }]
        });

        if (affectedNgos.length === 0) {
            return res.status(200).json({ status: "success", message: "No NGO memberships found to clean up." });
        }

        // 3. Remove user ID from ngoAdmins and ngoWorkers arrays
        await ngoModel.updateMany(
            { $or: [{ ngoAdmins: userId }, { ngoWorkers: userId }] },
            {
                $pull: {
                    ngoAdmins: userId,
                    ngoWorkers: userId
                }
            }
        );

        // 4. Invalidate Redis cache for all impacted NGOs
        const cacheDelPromises = affectedNgos.map(ngo =>
            safeRedis.del(RedisKeys.ngoDetails(ngo._id.toString()))
        );
        await Promise.all(cacheDelPromises);

        return res.status(200).json({
            status: "success",
            message: "User successfully scrubbed from all NGO member rosters and Redis caches."
        });

    } catch (error: any) {
        console.error("Error in cleanupDeletedUserController:", error);
        return res.status(500).json({ status: "failed", message: "Failed to cleanup user NGO memberships." });
    }
};


export const updateNgoProfileController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { ngoId } = req.params;
        const { name, location } = req.body;
        const currentUserId = req.user?._id?.toString();
        const isSuperAdmin = req.user?.role === "SUPER_ADMIN";

        if (!ngoId) {
            return res.status(400).json({ status: "failed", message: "NGO ID parameter is required." });
        }

        if (!name && !location) {
            return res.status(400).json({ status: "failed", message: "No updatable fields provided." });
        }

        // 1. Fetch Mongoose Document directly from DB to preserve .save() and instance methods
        const ngoDoc = await ngoModel.findById(ngoId);
        if (!ngoDoc) {
            return res.status(404).json({ status: "failed", message: "NGO not found." });
        }

        // 2. Authorization Check: Must be Super Admin or an NGO Admin of this NGO
        const isNgoAdmin = ngoDoc.ngoAdmins?.some((id: any) => id.toString() === currentUserId);
        if (!isSuperAdmin && !isNgoAdmin) {
            return res.status(403).json({
                status: "failed",
                message: "Forbidden: You are not authorized to update this NGO profile."
            });
        }

        // 3. Apply Selective Updates
        if (name) {
            ngoDoc.name = name.trim();
        }

        if (location) {
            // Ensure GeoJSON format compliance
            if (location.address) ngoDoc.location.address = location.address;
            if (location.coordinates && Array.isArray(location.coordinates)) {
                ngoDoc.location.coordinates = location.coordinates; // [longitude, latitude]
            }
        }

        // 4. Save to MongoDB (Triggers schema validation automatically)
        await ngoDoc.save();

        const updatedNgoObj = ngoDoc.toObject();

        // 5. Update / Invalidate Redis Cache
        const cacheKey = RedisKeys.ngoDetails(ngoId.toString());
        await safeRedis.set(
            cacheKey,
            JSON.stringify(updatedNgoObj),
            { EX: 86400 } // 24 hours TTL
        );
        // Redis GEOADD expects: key, longitude, latitude, member_id
        await safeRedis.geoAdd("ngo:locations",
            location.coordinates[0],
            location.coordinates[1],
            ngoId.toString()
        );

        return res.status(200).json({
            status: "success",
            message: "NGO profile updated successfully.",
            data: updatedNgoObj
        });

    } catch (error: any) {
        console.error("Error in updateNgoProfileController:", error);

        // Handle MongoDB duplicate key error (e.g., duplicate NGO name)
        if (error.code === 11000) {
            return res.status(409).json({
                status: "failed",
                message: "An NGO with this name already exists."
            });
        }

        return res.status(500).json({
            status: "failed",
            message: "Internal server error updating NGO profile."
        });
    }
};

export const transferOwnershipController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { ngoId } = req.params;
        const { newAdminId } = req.body;
        const currentUserId = req.user?._id?.toString();
        const isSuperAdmin = req.user?.role === "SUPER_ADMIN";

        if (!ngoId || !newAdminId) {
            return res.status(400).json({ status: "failed", message: "ngoId and newAdminId are required." });
        }

        // 1. Fetch NGO Document
        const ngoDoc = await ngoModel.findById(ngoId);
        if (!ngoDoc) {
            return res.status(404).json({ status: "failed", message: "NGO not found." });
        }

        // 2. Security Check: Only current Founder (adminId) or Super Admin can transfer ownership
        const isCurrentFounder = ngoDoc.adminId.toString() === currentUserId;
        if (!isCurrentFounder && !isSuperAdmin) {
            return res.status(403).json({
                status: "failed",
                message: "Forbidden: Only the primary founder or a Super Admin can transfer NGO ownership."
            });
        }

        const oldAdminId = ngoDoc.adminId.toString();

        // 3. Update primary founder in MongoDB
        ngoDoc.adminId = newAdminId;

        // Ensure the new admin is also present in the ngoAdmins array
        const isAlreadyInAdmins = ngoDoc.ngoAdmins.some(id => id.toString() === newAdminId);
        if (!isAlreadyInAdmins) {
            ngoDoc.ngoAdmins.push(newAdminId);
        }

        // 4. Interservice Call to auth_svc to promote new owner & adjust old owner's global role
        try {
            await axios.post(
                `${process.env.AUTH_SERVICE_URL}/internal/users/promote-founder`,
                { userId: newAdminId, ngoId },
                { headers: { "x-interservice-token": process.env.INTERSERVICE_SECRET } }
            );
        } catch (authError: any) {
            console.error("Interservice error sync with auth_svc:", authError.response?.data || authError.message);
            return res.status(502).json({
                status: "failed",
                message: "Failed to synchronize member removal with authentication service. Operation aborted."
            });
        }

        await ngoDoc.save();

        // 5. Update Redis Cache
        const updatedNgoObj = ngoDoc.toObject();
        await safeRedis.set(
            RedisKeys.ngoDetails(ngoId.toString()),
            JSON.stringify(updatedNgoObj),
            { EX: 86400 }
        );

        return res.status(200).json({
            status: "success",
            message: "NGO primary ownership transferred successfully.",
            data: {
                previousAdminId: oldAdminId,
                newAdminId: newAdminId
            }
        });

    } catch (error: any) {
        console.error("Error in transferOwnershipController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error transferring ownership." });
    }
};

export const removeMemberController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { ngoId, memberId } = req.params; // Restful: DELETE /:ngoId/members/:memberId
        const currentUserId = req.user?._id?.toString();
        const isSuperAdmin = req.user?.role === "SUPER_ADMIN";

        if (!ngoId || !memberId) {
            return res.status(400).json({ status: "failed", message: "Both ngoId and memberId are required." });
        }

        // 1. Fetch NGO Document from DB
        const ngoData = await ngoModel.findById(ngoId);
        if (!ngoData) {
            return res.status(404).json({ status: "failed", message: "NGO not found." });
        }

        // 2. Security Check: Must be Super Admin or NGO Admin of this NGO
        const isNgoAdmin = ngoData.ngoAdmins?.some((id: any) => id.toString() === currentUserId);
        if (!isSuperAdmin && !isNgoAdmin) {
            return res.status(403).json({
                status: "failed",
                message: "Forbidden: Only NGO admins or Super Admins can remove members."
            });
        }

        // 3. Founder Protection: Cannot remove primary founder via member cleanup
        if (ngoData.adminId.toString() === memberId.toString()) {
            return res.status(400).json({
                status: "failed",
                message: "Cannot remove primary founder. Transfer ownership first before removing this user."
            });
        }

        // 4. Interservice Call to auth_svc (Fail-Fast Approach)
        try {
            await axios.post(
                `${process.env.AUTH_SERVICE_URL}/internal/users/remove-ngo-from-userList`,
                { userId: memberId, ngoId },
                { headers: { "x-interservice-token": process.env.INTERSERVICE_SECRET } }
            );
        } catch (authError: any) {
            console.error("Interservice error sync with auth_svc:", authError.response?.data || authError.message);
            return res.status(502).json({
                status: "failed",
                message: "Failed to synchronize member removal with authentication service. Operation aborted."
            });
        }

        // 5. In-Memory Filter
        ngoData.ngoAdmins = ngoData.ngoAdmins.filter(
            (id) => id.toString() !== memberId.toString()
        );
        ngoData.ngoWorkers = ngoData.ngoWorkers.filter(
            (id) => id.toString() !== memberId.toString()
        );

        // 6. Save to MongoDB
        await ngoData.save();

        // 7. Update Redis Cache (Write-Through)
        const updatedNgoObj = ngoData.toObject();
        await safeRedis.set(
            RedisKeys.ngoDetails(ngoId.toString()),
            JSON.stringify(updatedNgoObj),
            { EX: 86400 }
        );

        return res.status(200).json({
            status: "success",
            message: "Member successfully removed from NGO.",
            data: { removedMemberId: memberId }
        });

    } catch (error) {
        console.error("Error in removeMemberController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error removing member." });
    }
};

export const deleteNgoController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { ngoId } = req.params;
        const currentUserId = req.user?._id?.toString();
        const isSuperAdmin = req.user?.role === "SUPER_ADMIN";

        if (!ngoId) {
            return res.status(400).json({ status: "failed", message: "NGO ID parameter is required." });
        }

        // 1. Fetch NGO Document
        const ngoDoc = await ngoModel.findById(ngoId);
        if (!ngoDoc) {
            return res.status(404).json({ status: "failed", message: "NGO not found." });
        }

        // 2. Authorization Check: Only primary founder (adminId) or Super Admin can delete the NGO
        const isPrimaryFounder = ngoDoc.adminId.toString() === currentUserId;
        if (!isPrimaryFounder && !isSuperAdmin) {
            return res.status(403).json({
                status: "failed",
                message: "Forbidden: Only the primary founder or a Super Admin can delete this NGO."
            });
        }

        // Gather all member IDs (admins + workers) to send to auth_svc
        const allMemberIds = Array.from(
            new Set([
                ngoDoc.adminId.toString(),
                ...(ngoDoc.ngoAdmins || []).map((id: any) => id.toString()),
                ...(ngoDoc.ngoWorkers || []).map((id: any) => id.toString())
            ])
        );

        // 3. Interservice Sync with auth_svc (Fail-Fast approach)
        try {
            await axios.post(
                `${process.env.AUTH_SERVICE_URL}/internal/ngos/cleanup-deleted-ngo`,
                { ngoId, memberIds: allMemberIds },
                { headers: { "x-interservice-token": process.env.INTERSERVICE_SECRET } }
            );
        } catch (authError: any) {
            console.error(
                "Interservice error syncing NGO deletion with auth_svc:",
                authError.response?.data || authError.message
            );
            return res.status(502).json({
                status: "failed",
                message: "Failed to synchronize NGO deletion with Auth Service. Deletion aborted."
            });
        }

        // 4. Delete document from MongoDB
        await ngoModel.findByIdAndDelete(ngoId);

        // 5. Purge Redis Cache
        const cacheKey = RedisKeys.ngoDetails(ngoId.toString());
        await safeRedis.del(cacheKey);

        return res.status(200).json({
            status: "success",
            message: "NGO permanently deleted and all associated member roles synchronized."
        });

    } catch (error: any) {
        console.error("Error in deleteNgoController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error deleting NGO." });
    }
};