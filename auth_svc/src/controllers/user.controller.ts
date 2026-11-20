import { userModel } from "../models/user.model";
import jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { sendEmail } from "../utils/sendEmail";
import { OAuth2Client } from "google-auth-library";
import { RedisKeys } from "../utils/redisKeys";
import { safeRedis, redisClient } from "../config/redis";
import axios from "axios";
import { bulkUserDeletionQueue } from "../queues/auth.queue";


const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const PROFILE_TTL = 24 * 60 * 60;

// Single shape for the user profile: used for API responses AND the Redis profile cache,
// so every reader (auth middleware, /me, refresh) sees the same fields. Never includes secrets.
const toUserPayload = (user: any) => ({
    _id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone || null,
    role: user.role,
    profilePic: user.profilePic,
    ngoId: user.ngoId ? user.ngoId.toString() : null, // the NGO this user owns
    joinedNGOs: (user.joinedNGOs ?? []).map((j: any) => ({
        ngoId: j.ngoId.toString(),
        roleInNGO: j.roleInNGO
    })),
    verificationStatus: user.verificationStatus,
    isActive: user.isActive,
    isGoogleUser: user.isGoogleUser,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
});

const cacheUserProfile = async (user: any) => {
    await safeRedis.set(
        RedisKeys.userProfile(user._id.toString()),
        JSON.stringify(toUserPayload(user)),
        { EX: PROFILE_TTL }
    );
};

// Global role derived from memberships (SUPER_ADMIN is never touched).
const recalcGlobalRole = (user: any) => {
    if (user.role === "SUPER_ADMIN") return;
    const roles = (user.joinedNGOs ?? []).map((j: any) => j.roleInNGO);
    if (roles.includes("NGO_ADMIN")) user.role = "NGO_ADMIN";
    else if (roles.includes("NGO_WORKER")) user.role = "NGO_WORKER";
    else if (roles.includes("VOLUNTEER")) user.role = "VOLUNTEER";
    else user.role = "RESIDENT";
};

const setMembership = (user: any, ngoId: string, roleInNGO: string) => {
    const idx = user.joinedNGOs.findIndex((j: any) => j.ngoId.toString() === ngoId.toString());
    if (idx !== -1) user.joinedNGOs[idx].roleInNGO = roleInNGO;
    else user.joinedNGOs.push({ ngoId, roleInNGO });
};

//Phone number in google auth, otp verification, avatar/dp are not implemented yet.
//No user role safety implemented yet. Create a otp or email check route for verification.
//No refresh token rotation yet implemented.
//i mplement email smtp api on production instead of sandbox
//The route and working of googleAuthController is not tested yet.
//and also not utilized the isgoogleuser field properly.
//havent implemented profile images yet.

const userRegistrationController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { name, email, password, phone, profilePic } = req.body;

        if (!name || !email || !password || !phone) {
            return res.status(400).json({ message: "All core fields are required.", status: "failed" });
        }

        const normalizedEmail = email.toLowerCase();
        const emailKey = RedisKeys.userByEmail(normalizedEmail);

        // 1. Check Redis first (safeRedis handles errors silently if Redis is down)
        const cachedUser = await safeRedis.get(emailKey);
        if (cachedUser) {
            return res.status(422).json({
                message: "User with this email already exists.",
                status: "failed"
            });
        }

        // 2. Cache Miss: Check MongoDB
        const ifExists = await userModel.findOne({ email: normalizedEmail });
        if (ifExists) {
            await safeRedis.set(emailKey, JSON.stringify({ _id: ifExists._id, email: ifExists.email }), { EX: 24 * 60 * 60 });
            return res.status(422).json({
                message: "User with this email already exists.",
                status: "failed"
            });
        }

        // 3. Create User in MongoDB
        const user = await userModel.create({
            name,
            email: normalizedEmail,
            passwordHash: password,
            phone,
            role: 'RESIDENT',
            profilePic: profilePic || "https://cdn-icons-png.flaticon.com/512/149/149071.png",
            joinedNGOs: []
        });

        const userPayload = toUserPayload(user);

        // 4. Cache user profile in Redis
        await safeRedis.set(emailKey, JSON.stringify({ _id: user._id, email: user.email }), { EX: PROFILE_TTL });
        await cacheUserProfile(user);

        // 5. Generate Tokens & Response
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();
        // Register the session so /refresh-token and the auth middleware accept it (same as login)
        await safeRedis.set(RedisKeys.userRefreshToken(userPayload._id), refreshToken, { EX: 7 * 24 * 60 * 60 });

        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict" as const,
            maxAge: 7 * 24 * 60 * 60 * 1000
        };

        return res
            .cookie("refreshToken", refreshToken, cookieOptions)
            .status(201)
            .json({
                status: "success",
                user: userPayload,
                accessToken
            });

    } catch (error: any) {
        if (error.code === 11000) {
            return res.status(422).json({
                message: "User with this email already exists.",
                status: "failed"
            });
        }

        console.error("Error in user registration:", error);
        return res.status(500).json({ message: "Internal server error in user registration.", status: "failed" });
    }
};

const updateUserProfileController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const userId = req.user?._id?.toString();
        if (!userId) {
            return res.status(401).json({ status: "failed", message: "Unauthorized context." });
        }

        const { name, phone, profilePic } = req.body;

        // 1. Build dynamic update payload with strictly allowed fields
        const updates: Record<string, any> = {};

        if (name !== undefined) updates.name = name.trim();
        if (phone !== undefined) updates.phone = phone.trim();
        if (profilePic !== undefined) updates.profilePic = profilePic.trim();

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                status: "failed",
                message: "No valid fields provided for update. Only 'name', 'phone', and 'profilePic' can be updated."
            });
        }

        // 2. Update MongoDB Document
        const updatedUser = await userModel.findByIdAndUpdate(
            userId,
            { $set: updates },
            { new: true, runValidators: true }
        ).select("-passwordHash");

        if (!updatedUser) {
            return res.status(404).json({
                status: "failed",
                message: "User profile not found."
            });
        }

        // 3. Construct updated user payload
        const userPayload = toUserPayload(updatedUser);

        // 4. Refresh Redis profile cache
        await cacheUserProfile(updatedUser);

        return res.status(200).json({
            status: "success",
            message: "User profile updated successfully.",
            user: userPayload
        });

    } catch (error: any) {
        console.error("Error in updateUserProfileController:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error updating user profile."
        });
    }
};

const promoteFounderController = async (req: Request, res: Response): Promise<Response> => {
    try {

        const { userId, ngoId } = req.body;

        if (!userId || !ngoId) {
            return res.status(400).json({
                status: "failed",
                message: "Both userId and ngoId are required."
            });
        }

        // 2. Fetch User
        const user = await userModel.findById(userId);
        if (!user) {
            return res.status(404).json({
                status: "failed",
                message: "Founder user account not found."
            });
        }

        // 3. Link NGO: the founder OWNS it (ngoId) and is an admin member of it (joinedNGOs)
        if (!user.ngoId) {
            user.ngoId = ngoId;
        }
        setMembership(user, ngoId, "NGO_ADMIN");
        recalcGlobalRole(user);

        await user.save({ validateBeforeSave: false });

        // 4. Write-through profile cache so the next token refresh carries ngoId + joinedNGOs
        await cacheUserProfile(user);

        return res.status(200).json({
            status: "success",
            message: "Founder successfully promoted to NGO_ADMIN and linked to NGO.",
            user: toUserPayload(user)
        });

    } catch (error: any) {
        console.error("Error in promoteFounderController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error promoting founder." });
    }
};

const promoteCoAdminController = async (req: Request, res: Response): Promise<Response> => {
    try {

        const { targetUserId, ngoId } = req.body;

        if (!targetUserId || !ngoId) {
            return res.status(400).json({
                status: "failed",
                message: "Both targetUserId and ngoId are required."
            });
        }

        // 2. Fetch target user
        const user = await userModel.findById(targetUserId);
        if (!user) {
            return res.status(404).json({
                status: "failed",
                message: "Target user not found."
            });
        }

        // 3. Update Role & Link NGO
        setMembership(user, ngoId, "NGO_ADMIN");
        recalcGlobalRole(user);

        await user.save({ validateBeforeSave: false });
        await cacheUserProfile(user);

        return res.status(200).json({
            status: "success",
            message: `User (${targetUserId}) successfully promoted to NGO_ADMIN for NGO ${ngoId}.`
        });

    } catch (error: any) {
        console.error("Error in promoteCoAdminController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error promoting co-admin." });
    }
};

const addCoWorkerController = async (req: Request, res: Response): Promise<Response> => {
    try {

        const { targetUserIdentifier, ngoId, roleInNGO } = req.body;

        if (!targetUserIdentifier || !ngoId || !roleInNGO) {
            return res.status(400).json({
                status: "failed",
                message: "targetUserIdentifier, ngoId, and roleInNGO are required."
            });
        }

        // 1. Fetch User
        const user = await userModel.findById(targetUserIdentifier);
        if (!user) {
            return res.status(404).json({ status: "failed", message: "User not found." });
        }

        // 2. Update or Add NGO Membership Subdocument
        setMembership(user, ngoId, roleInNGO);

        // 3. Global role from ALL memberships (handles promotions & demotions)
        recalcGlobalRole(user);

        await user.save();

        // 4. Write-through profile cache
        await cacheUserProfile(user);

        return res.status(200).json({
            status: "success",
            message: "User NGO membership and roles updated successfully.",
            data: {
                targetUserId: user._id.toString(),
                updatedGlobalRole: user.role,
                ngoRole: roleInNGO
            }
        });

    } catch (error: any) {
        console.error("Error in addCoWorkerController:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error updating user NGO membership."
        });
    }
};

const userRefreshTokenController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { refreshToken } = req.cookies;
        if (!refreshToken) {
            return res.status(401).json({ message: "No RefreshToken provided.", status: "failed" });
        }

        // 1. Verify Refresh Token JWT signature
        let decoded: any;
        try {
            decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!);
        } catch (error) {
            return res.status(403).json({ message: "Invalid or expired refresh token. Please login again.", status: "failed" });
        }

        const userId = decoded.userId || decoded._id;

        // 2. Validate Session Revocation in Redis
        // Login/register/Google sign-in always store the active refresh token, and logout / password reset
        // delete it. So when Redis is up, a missing entry means the session was ended: reject it.
        // (If Redis is down we can't tell, and fall back to the JWT signature alone.)
        const storedRefreshToken = await safeRedis.get(RedisKeys.userRefreshToken(userId));
        const sessionUnknown = redisClient.isOpen && storedRefreshToken === null;
        if (sessionUnknown || (storedRefreshToken && storedRefreshToken !== refreshToken)) {
            return res.status(403).json({ message: "Session revoked or active on another device. Please sign in again.", status: "failed" });
        }

        // 3. Always read the user from MongoDB here: a refresh is how a client picks up a changed
        //    role / ngoId / joinedNGOs (e.g. right after its NGO got approved), so it must not be stale.
        const dbUser = await userModel.findById(userId);
        if (!dbUser) {
            return res.status(404).json({ message: "No user found!", status: "failed" });
        }

        // 4. Check status
        if (!dbUser.isActive) {
            return res.status(403).json({ message: "This account has been suspended!", status: "failed" });
        }

        await cacheUserProfile(dbUser);

        // 5. Same token shape as login (includes ngoId + joinedNGOs)
        const newAccessToken = dbUser.generateAccessToken();

        return res.status(200).json({
            status: "success",
            accessToken: newAccessToken,
            user: toUserPayload(dbUser)
        });

    } catch (error) {
        console.error("Error inside token rotation:", error);
        return res.status(500).json({ message: "Internal server error in refresh token controller.", status: "failed" });
    }
};

const userLoginController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: "Provide both email and password!", status: "failed" });
        }

        const normalizedEmail = email.toLowerCase();

        // 1. Fetch user & password hash directly from MongoDB (Security Best Practice)
        const user = await userModel.findOne({ email: normalizedEmail }).select("+passwordHash");
        if (!user) {
            return res.status(404).json({ message: "No user found!", status: "failed" });
        }
        if (!user.isActive) {
            return res.status(403).json({ message: "Account suspended!", status: "failed" });
        }

        // 2. Validate Password
        const isPassValid = await bcrypt.compare(password, user.passwordHash);
        if (!isPassValid) {
            return res.status(400).json({ message: "Invalid email or password!", status: "failed" });
        }

        // 3. Prepare Safe User Profile Payload (EXCLUDING passwordHash)
        const userPayload = toUserPayload(user);

        // 4. Cache User Profile & Refresh Token Session in Redis
        await cacheUserProfile(user);
        await safeRedis.set(RedisKeys.userByEmail(normalizedEmail), JSON.stringify({ _id: userPayload._id, email: userPayload.email }), { EX: 24 * 60 * 60 });

        // 5. Generate Tokens
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();

        // Store active refresh token to enable instant session revocation
        await safeRedis.set(RedisKeys.userRefreshToken(userPayload._id), refreshToken, { EX: 7 * 24 * 60 * 60 });

        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict" as const,
            maxAge: 7 * 24 * 60 * 60 * 1000
        };

        return res
            .cookie("refreshToken", refreshToken, cookieOptions)
            .status(200)
            .json({
                status: "success",
                user: userPayload,
                accessToken
            });

    } catch (error) {
        console.error("Error in user login:", error);
        return res.status(500).json({ message: "Internal server error during login.", status: "failed" });
    }
};

const userLogoutController = async (req: Request, res: Response): Promise<Response> => {

    try {
        // /logout has no auth middleware (the access token may already be expired),
        // so identify the session from the refresh cookie as a fallback.
        let userId: any = req.user?._id;
        if (!userId && req.cookies?.refreshToken) {
            try {
                const decoded: any = jwt.verify(req.cookies.refreshToken, process.env.JWT_REFRESH_SECRET!);
                userId = decoded.userId || decoded._id;
            } catch {
                // invalid/expired cookie: nothing to revoke server-side
            }
        }

        if (userId) {
            const userIdStr = userId.toString();

            // Delete both session refresh token and cached user profile simultaneously
            await safeRedis.del([
                RedisKeys.userRefreshToken(userIdStr),
                RedisKeys.userProfile(userIdStr)
            ]);
        }

        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict" as const
        };

        return res
            .clearCookie("refreshToken", cookieOptions)
            .status(200)
            .json({
                status: "success",
                message: "Logged out successfully."
            });

    } catch (error) {
        console.error("Error in logout controller:", error);
        return res.status(500).json({ message: "Internal server error during logout.", status: "failed" });
    }

};

const getUserProfileController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const id = req.user?._id;

        // 1. Defend against missing middleware injection context
        if (!id) {
            return res.status(401).json({ message: "User context missing or unauthenticated.", status: "failed" });
        }

        const userKey = RedisKeys.userProfile(id.toString());

        // 2. Fast Path: Check Redis cache first (using correct key helper)
        const redisUser = await safeRedis.get(userKey);
        if (redisUser) {
            const userRedis = JSON.parse(redisUser);

            if (!userRedis.isActive) {
                return res.status(403).json({ message: "Account has been suspended.", status: "failed" });
            }

            return res.status(200).json({ status: "success", user: userRedis });
        }

        // 3. Cache Miss: Fetch from MongoDB
        const user = await userModel.findById(id).select("-passwordHash -refreshTokens");

        if (!user) {
            return res.status(404).json({ message: "User profile does not exist.", status: "failed" });
        }

        if (!user.isActive) {
            return res.status(403).json({ message: "Account has been suspended.", status: "failed" });
        }

        const userPayload = toUserPayload(user);

        // 4. Repopulate Redis Cache
        await cacheUserProfile(user);

        // 5. Return profile payload
        return res.status(200).json({
            status: "success",
            user: userPayload
        });

    } catch (error) {
        console.error(`Error while fetching profile: ${error}`);
        return res.status(500).json({ message: "Internal server error while fetching profile.", status: "failed" });
    }
};

const forgotPasswordController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ message: "Please provide an email address.", status: "failed" });
        }

        const normalizedEmail = email.toLowerCase();

        // 1. Fetch user from MongoDB (or cached profile if available)
        const user = await userModel.findOne({ email: normalizedEmail });

        // Security Guard: Return 200 even if email doesn't exist to prevent email enumeration attacks
        if (!user) {
            return res.status(200).json({
                status: "success",
                message: "If an account with that email exists, a reset link has been sent."
            });
        }

        // 2. Generate raw and hashed reset tokens
        const resetToken = crypto.randomBytes(32).toString("hex");
        const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

        // 3. Store hashed token in Redis pointing to userId (TTL: 15 minutes / 900s)
        const RESET_TOKEN_TTL = 15 * 60;
        await safeRedis.set(
            RedisKeys.passwordResetToken(hashedToken),
            user._id.toString(),
            { EX: RESET_TOKEN_TTL }
        );

        // 4. Construct URL and send email
        const resetURL = `${req.protocol}://${req.get("host")}/api/auth/reset-password/${resetToken}`;
        const message = `Forgot your password? Submit a PATCH request with your new password to:\n\n${resetURL}\n\nThis link is valid for 15 minutes.`;

        try {
            await sendEmail({
                email: user.email,
                subject: "Your Password Reset Token (Valid for 15 mins)",
                message
            });

            return res.status(200).json({
                status: "success",
                message: "Reset token sent to email!"
            });

        } catch (err) {
            // Clean up token from Redis if email dispatch fails
            await safeRedis.del(RedisKeys.passwordResetToken(hashedToken));
            console.error(`Error while sending email: ${err}`);
            return res.status(500).json({ message: "Error sending email. Try again later.", status: "failed" });
        }

    } catch (error: any) {
        console.error(`Error while forgot password: ${error}`);
        return res.status(500).json({ message: "Internal server error during forgot password process.", status: "failed" });
    }
};

const resetPasswordController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ message: "Please provide your new password.", status: "failed" });
        }

        const tokenParam = req.params.token as string;
        if (!tokenParam) {
            return res.status(400).json({ message: "Invalid route request. Token parameter missing.", status: "failed" });
        }

        // 1. Hash the incoming token param
        const hashedToken = crypto.createHash("sha256").update(tokenParam).digest("hex");
        const resetKey = RedisKeys.passwordResetToken(hashedToken);

        // 2. Validate token against Redis
        const userId = await safeRedis.get(resetKey);
        if (!userId) {
            return res.status(400).json({ message: "Token is invalid or has expired.", status: "failed" });
        }

        // 3. Find user in MongoDB and update password (triggering pre-save bcrypt hash)
        const user = await userModel.findById(userId).select("+passwordHash");
        if (!user) {
            return res.status(404).json({ message: "User associated with this token no longer exists.", status: "failed" });
        }

        user.passwordHash = password;
        await user.save();

        const userIdStr = user._id.toString();

        // 4. Invalidate used reset token AND revoke all active user sessions/cached profile
        await safeRedis.del([
            resetKey,
            RedisKeys.userRefreshToken(userIdStr),
            RedisKeys.userProfile(userIdStr)
        ]);

        return res.status(200).json({
            status: "success",
            message: "Password updated successfully. All existing sessions logged out. You can now login!"
        });

    } catch (error: any) {
        console.error("Error in reset password controller:", error);
        return res.status(500).json({ message: "Internal server error during password reset.", status: "failed" });
    }
};

const deleteUserController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const userId = req.user?._id;

        if (!userId) {
            return res.status(400).json({ status: "failed", message: "User Id is needed to delete user." });
        }

        const userIdStr = userId.toString();

        // 1. Interservice Call to ngo_svc to scrub NGO memberships
        try {
            await axios.delete(
                `${process.env.NGO_SERVICE_URL}/api/ngo/internal/users/${userIdStr}/cleanup`,
                {
                    headers: { "x-internal-key": process.env.INTERNAL_API_KEY },
                    timeout: 8000
                }
            );
        } catch (ngoServiceError: any) {
            // Handle founder restriction or service failure
            const failureMessage = ngoServiceError.response?.data?.message || "Failed to notify NGO service.";
            return res.status(400).json({
                status: "failed",
                message: `Account deletion aborted: ${failureMessage}`
            });
        }

        // 2. Delete user from auth_svc MongoDB
        const deletedUser = await userModel.findByIdAndDelete(userIdStr);
        if (!deletedUser) {
            return res.status(404).json({ status: "failed", message: "User not found." });
        }

        // 3. Clear Redis sessions & refresh tokens
        await safeRedis.del([
            RedisKeys.userRefreshToken(userIdStr),
            RedisKeys.userProfile(userIdStr)
        ]);

        // 4. Clear auth cookie & respond
        return res
            .clearCookie("refreshToken", {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "strict"
            })
            .status(200)
            .json({ status: "success", message: "User account permanently deleted from the system." });

    } catch (error: any) {
        console.error(`Error while deleting user: ${error}`);
        return res.status(500).json({ status: "failed", message: "Internal server error deleting user account." });
    }
};

const googleAuthController = async (req: Request, res: Response): Promise<Response> => {

    try {
        const { idToken } = req.body;
        if (!idToken) return res.status(400).json({ "status": "failed", "message": "Google id token is missing." });

        // 1. Verify the token directly with Google's servers
        const ticket = await client.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        if (!payload || !payload.email) {
            return res.status(400).json({ message: "Invalid Google token payload." });
        }

        const { email, name, picture } = payload;

        // 2. Check if the user already exists in your DB
        let user = await userModel.findOne({ email: email.toLowerCase() });
        // Only an EXISTING suspended account is rejected; a missing account is created below.
        if (user && !user.isActive) {
            return res.status(403).json({ status: "failed", message: "The user is active no more or id is banned." });
        }

        if (!user) {
            // Registration path: Create a new user account on the fly
            // Since it's OAuth, we generate a random dummy password that passes DB validation
            const randomPassword = crypto.randomBytes(16).toString("hex");

            user = await userModel.create({
                name: name || email.split("@")[0],
                email: email.toLowerCase(),
                passwordHash: randomPassword,
                role: "RESIDENT", // Default fallback role
                ngoId: null,
                profilePic: picture || undefined,
                isGoogleUser: true
            });
        }

        const accessToken = user.generateAccessToken();

        const refreshToken = user.generateRefreshToken();

        const userIdStr = user._id.toString();

        const userPayload = toUserPayload(user);

        // Store in Redis matching your project's data schema and TTL patterns
        await Promise.all([
            safeRedis.set(
                RedisKeys.userRefreshToken(userIdStr),
                refreshToken,
                { EX: 7 * 24 * 60 * 60 } // 7 days
            ),
            safeRedis.set(
                RedisKeys.userProfile(userIdStr),
                JSON.stringify(userPayload),
                { EX: 24 * 60 * 60 } // 1 hour
            ),
            safeRedis.set(
                RedisKeys.userByEmail(user.email),
                JSON.stringify({ _id: userIdStr, email: user.email }),
                { EX: 24 * 60 * 60 } // 1 hour
            ),
        ]);

        // 4. Set the HTTP-Only cookie and respond
        return res
            .cookie("refreshToken", refreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "strict" as const,
                maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
            })
            .status(200)
            .json({
                status: "success",
                message: "Google authentication successful.",
                accessToken,
                user: {
                    _id: user._id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                }
            });

    } catch (error) {
        console.error(`Google Auth Error: ${error}`);
        return res.status(401).json({ message: "Google authentication failed. Token may be expired." });
    }

};

const transferFounderRoleInternalController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { previousAdminId, newAdminId, ngoId } = req.body;

        if (!previousAdminId || !newAdminId || !ngoId) {
            return res.status(400).json({
                status: "failed",
                message: "previousAdminId, newAdminId, and ngoId are required."
            });
        }

        // 1. Promote New Admin
        const newAdmin = await userModel.findById(newAdminId);
        if (!newAdmin) {
            return res.status(404).json({ status: "failed", message: "New admin user account not found." });
        }

        // New owner: owns this NGO (if they don't own one already) and is an admin member of it
        if (!newAdmin.ngoId) {
            newAdmin.ngoId = ngoId;
        }
        setMembership(newAdmin, ngoId, "NGO_ADMIN");
        recalcGlobalRole(newAdmin);

        await newAdmin.save();
        await cacheUserProfile(newAdmin);

        // 2. Previous owner: no longer owns it, but stays an admin member of it
        //    (the new owner can remove them later via member removal).
        const previousAdmin = await userModel.findById(previousAdminId);
        if (previousAdmin) {
            if (previousAdmin.ngoId?.toString() === ngoId.toString()) {
                previousAdmin.ngoId = null;
            }
            recalcGlobalRole(previousAdmin);
            await previousAdmin.save();
            await cacheUserProfile(previousAdmin);
        }

        return res.status(200).json({
            status: "success",
            message: "Founder role successfully transferred in auth_svc."
        });

    } catch (error: any) {
        console.error("Error in transferFounderRoleInternalController:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error syncing ownership transfer."
        });
    }
};

const removeNgoFromUserListInternalController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { userId, ngoId } = req.body;
        const user = await userModel.findById(userId);

        if (!user) {
            return res.status(404).json({ status: "failed", message: "User not found." });
        }

        // 1. Remove NGO subdocument from joinedNGOs array
        user.joinedNGOs = user.joinedNGOs.filter(
            (item) => item.ngoId.toString() !== ngoId.toString()
        );

        if (user.ngoId?.toString() === ngoId.toString()) {
            user.ngoId = null;
        }

        // 2. Recalculate global role from remaining memberships
        recalcGlobalRole(user);

        await user.save();

        // 3. Refresh user profile in Redis
        await cacheUserProfile(user);

        return res.status(200).json({ status: "success", message: "User NGO roster updated successfully." });
    } catch (error) {
        console.error("Error in removeNgoFromUserListInternalController:", error);
        return res.status(500).json({ status: "failed", message: "Internal error updating user rosters." });
    }
};

const cleanupDeletedNgoInternalController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { ngoId, memberIds } = req.body;

        if (!ngoId || !Array.isArray(memberIds)) {
            return res.status(400).json({
                status: "failed",
                message: "ngoId and memberIds array are required."
            });
        }

        // Fetch all impacted users
        const users = await userModel.find({ _id: { $in: memberIds } });

        const savePromises = users.map(async (user) => {
            // 1. Filter out the deleted NGO from joinedNGOs array
            user.joinedNGOs = user.joinedNGOs.filter(
                (item) => item.ngoId.toString() !== ngoId.toString()
            );

            if (user.ngoId?.toString() === ngoId.toString()) {
                user.ngoId = null;
            }

            // 2. Recalculate global system role (preserves SUPER_ADMIN)
            recalcGlobalRole(user);

            await user.save();

            // 3. Refresh individual user profile cache
            await cacheUserProfile(user);
        });

        await Promise.all(savePromises);

        return res.status(200).json({
            status: "success",
            message: "All member profiles updated after NGO deletion."
        });

    } catch (error: any) {
        console.error("Error in cleanupDeletedNgoInternalController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error cleaning up deleted NGO members." });
    }
};

const bulkDeleteUsersController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { userIds } = req.body;
        const adminUserId = req.user?._id?.toString();

        if (!Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({
                status: "failed",
                message: "userIds must be a non-empty array of strings."
            });
        }

        // Enqueue background job
        const job = await bulkUserDeletionQueue.add("bulk-delete-users-job", {
            userIds,
            adminUserId
        });

        return res.status(202).json({
            status: "success",
            message: `Bulk user deletion job queued for ${userIds.length} users. Processing in background.`,
            data: {
                jobId: job.id,
                queuedCount: userIds.length
            }
        });
    } catch (error) {
        console.error("Error in bulkDeleteUsersController:", error);
        return res.status(500).json({
            status: "failed",
            message: "Internal server error queuing bulk user deletion."
        });
    }
};

// GET /users/lookup?email=  (NGO_ADMIN / SUPER_ADMIN) -> find a user to add as an NGO member
const lookupUserByEmailController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const email = String(req.query.email || "").trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ status: "failed", message: "email query parameter is required." });
        }
        const user = await userModel.findOne({ email }).select("_id name email isActive").lean();
        if (!user || !user.isActive) {
            return res.status(404).json({ status: "failed", message: "No active user with that email." });
        }
        return res.status(200).json({
            status: "success",
            user: { _id: user._id.toString(), name: user.name, email: user.email }
        });
    } catch (error) {
        console.error("Error in lookupUserByEmailController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error looking up user." });
    }
};

// POST /users/basic { ids: [] } (any logged-in user) -> display names for member lists.
// Emails are only included for admins.
const getUsersBasicController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
        const validIds = ids.filter((id: string) => /^[a-f0-9]{24}$/i.test(id)).slice(0, 200);
        if (validIds.length === 0) {
            return res.status(200).json({ status: "success", users: [] });
        }
        const showEmail = ["NGO_ADMIN", "SUPER_ADMIN"].includes(req.user?.role ?? "");
        const users = await userModel.find({ _id: { $in: validIds } }).select("_id name email").lean();
        return res.status(200).json({
            status: "success",
            users: users.map((u) => ({
                _id: u._id.toString(),
                name: u.name,
                ...(showEmail ? { email: u.email } : {})
            }))
        });
    } catch (error) {
        console.error("Error in getUsersBasicController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error fetching users." });
    }
};

export {
    lookupUserByEmailController,
    getUsersBasicController,
    userRegistrationController,
    updateUserProfileController,
    promoteFounderController,
    promoteCoAdminController,
    addCoWorkerController,
    userRefreshTokenController,
    userLoginController,
    userLogoutController,
    getUserProfileController,
    forgotPasswordController,
    resetPasswordController,
    deleteUserController,
    googleAuthController,
    transferFounderRoleInternalController,
    removeNgoFromUserListInternalController,
    cleanupDeletedNgoInternalController,
    bulkDeleteUsersController
};