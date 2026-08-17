import { userModel } from "../models/user.model.ts";
import jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { sendEmail } from "../utils/sendEmail.ts";
import { OAuth2Client } from "google-auth-library";
import { RedisKeys } from "../utils/redisKeys";
import { safeRedis } from "../config/redis";


const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

//Phone number in google auth, otp verification, avatar/dp are not implemented yet.
//No user role safety implemented yet. Create a otp or email check route for verification.
//No refresh token rotation yet implemented.
//i mplement email smtp api on production instead of sandbox
//The route and working of googleAuthController is not tested yet.
//and also not utilized the isgoogleuser field properly.

const userRegistrationController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { name, email, password, phone } = req.body;

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
            joinedNGOs: []
        });

        const userPayload = {
            _id: user._id.toString(),
            name: user.name,
            email: user.email,
            phone: user.phone || null,
            role: user.role,
            joinedNGOs: user.joinedNGOs ?? [],
            verificationStatus: user.verificationStatus, // Dynamic, not hardcoded
            isActive: user.isActive,
            isGoogleUser: user.isGoogleUser,
            createdAt: user.createdAt
        };

        // 4. Cache user profile in Redis
        await safeRedis.set(emailKey, JSON.stringify({ _id: user._id, email: user.email }), { EX: 24 * 60 * 60 });
        await safeRedis.set(RedisKeys.userProfile(user._id.toString()), JSON.stringify(userPayload), { EX: 24 * 60 * 60 });

        // 5. Generate Tokens & Response
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();

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

        // 3. Promote Role & Link NGO
        user.role = "NGO_ADMIN";

        const alreadyJoined = user.joinedNGOs.some(id => id.toString() === ngoId.toString());
        if (!alreadyJoined) {
            user.joinedNGOs.push({ ngoId, roleInNGO: "NGO_ADMIN" });
        }

        await user.save({ validateBeforeSave: false });

        return res.status(200).json({
            status: "success",
            message: "Founder successfully promoted to NGO_ADMIN and linked to NGO."
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
        user.role = "NGO_ADMIN";

        const alreadyJoined = user.joinedNGOs.some(id => id.toString() === ngoId.toString());
        if (!alreadyJoined) {
            user.joinedNGOs.push(ngoId);
        }

        await user.save({ validateBeforeSave: false });

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
        const user = await userModel.findById(targetUserIdentifier);
        if (!user) {
            return res.status(404).json({ status: "failed", message: "User not found." });
        }

        const existingNGOIndex = user.joinedNGOs.findIndex(
            (item) => item.ngoId.toString() === ngoId.toString()
        );

        if (existingNGOIndex !== -1) {
            // Update role if already joined, or reject
            user.joinedNGOs[existingNGOIndex]!.roleInNGO = roleInNGO;
            user.role = roleInNGO;
        } else {
            // Add new membership entry
            user.joinedNGOs.push({ ngoId, roleInNGO });
            user.role = roleInNGO;
        }

        await user.save();

        return res.status(200).json({
            status: "success",
            data: { targetUserId: user._id.toString() }
        });
    } catch (error: any) {
        console.error("Error in addJoinedNGOInternalController:", error);
        return res.status(500).json({ status: "failed", message: "Internal server error updating user NGO membership." });
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
        const storedRefreshToken = await safeRedis.get(RedisKeys.userRefreshToken(userId));
        if (storedRefreshToken && storedRefreshToken !== refreshToken) {
            return res.status(403).json({ message: "Session revoked or active on another device.", status: "failed" });
        }

        // 3. Fast Path: Read cached user profile from Redis first
        let user: any = null;
        const cachedProfile = await safeRedis.get(RedisKeys.userProfile(userId));

        if (cachedProfile) {
            user = JSON.parse(cachedProfile);
        } else {
            // Cache Miss: Fall back to MongoDB
            const dbUser = await userModel.findById(userId);
            if (!dbUser) {
                return res.status(404).json({ message: "No user found!", status: "failed" });
            }

            user = {
                _id: user._id.toString(),
                name: user.name,
                email: user.email,
                phone: user.phone || null,
                role: user.role,
                joinedNGOs: user.joinedNGOs ?? [],
                verificationStatus: user.verificationStatus, // Dynamic, not hardcoded
                isActive: user.isActive,
                isGoogleUser: user.isGoogleUser,
                createdAt: user.createdAt
            };

            // Repopulate Cache
            await safeRedis.set(RedisKeys.userProfile(userId), JSON.stringify(user), { EX: 24 * 60 * 60 });
        }

        // 4. Check status
        if (!user.isActive) {
            return res.status(403).json({ message: "This account has been suspended!", status: "failed" });
        }

        // 5. Generate lean Access Token
        const newAccessToken = jwt.sign(
            {
                _id: user._id,
                email: user.email,
                role: user.role
            },
            process.env.JWT_ACCESS_SECRET!,
            { expiresIn: "45m" }
        );

        return res.status(200).json({
            status: "success",
            accessToken: newAccessToken
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
        const userPayload = {
            _id: user._id.toString(),
            name: user.name,
            email: user.email,
            phone: user.phone || null,
            role: user.role,
            joinedNGOs: user.joinedNGOs ?? [],
            verificationStatus: user.verificationStatus, // Dynamic, not hardcoded
            isActive: user.isActive,
            isGoogleUser: user.isGoogleUser,
            createdAt: user.createdAt
        };

        // 4. Cache User Profile & Refresh Token Session in Redis
        await safeRedis.set(RedisKeys.userProfile(userPayload._id), JSON.stringify(userPayload), { EX: 24 * 60 * 60 });
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
        const userId = req.user?._id;

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

            return res.status(200).json({
                status: "success",
                user: {
                    _id: userRedis._id.toString(),
                    name: userRedis.name,
                    email: userRedis.email,
                    phone: userRedis.phone || null,
                    role: userRedis.role,
                    joinedNGOs: userRedis.joinedNGOs ?? [],
                    verificationStatus: userRedis.verificationStatus, // Dynamic, not hardcoded
                    isActive: userRedis.isActive,
                    isGoogleUser: userRedis.isGoogleUser,
                    createdAt: userRedis.createdAt
                }
            });
        }

        // 3. Cache Miss: Fetch from MongoDB
        const user = await userModel.findById(id).select("-passwordHash -refreshTokens");

        if (!user) {
            return res.status(404).json({ message: "User profile does not exist.", status: "failed" });
        }

        if (!user.isActive) {
            return res.status(403).json({ message: "Account has been suspended.", status: "failed" });
        }

        const userPayload = {
            _id: user._id.toString(),
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            joinedNGOs: user.joinedNGOs ?? [],
            verificationStatus: user.verificationStatus,
            isActive: user.isActive
        };

        // 4. Repopulate Redis Cache (TTL: 7 days to match login session)
        await safeRedis.set(userKey, JSON.stringify(userPayload), { EX: 24 * 60 * 60 });

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

        const deletedUser = await userModel.findByIdAndDelete(userId);
        if (!deletedUser) return res.status(404).json({ message: "User not found." });

        const userIdStr = userId!.toString();
        await safeRedis.del([
            RedisKeys.userRefreshToken(userIdStr),
            RedisKeys.userProfile(userIdStr)
        ]);

        return res
            .clearCookie("refreshToken", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" })
            .status(200)
            .json({ message: "User account permanently deleted from the system." });
    } catch (error: any) {
        console.error(`Error while deleting user: ${error}`);
        return res.status(500).json({ message: error.message });
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
        let user = await userModel.findOne({ email });
        if (!user?.isActive) {
            return res.status(400).json({ status: "failed", message: "The user is active no more or id is banned." });
        }

        if (!user) {
            // Registration path: Create a new user account on the fly
            // Since it's OAuth, we generate a random dummy password that passes DB validation
            const randomPassword = crypto.randomBytes(16).toString("hex");

            user = await userModel.create({
                name,
                email,
                passwordHash: randomPassword,
                role: "RESIDENT", // Default fallback role
                ngoId: null,
                isGoogleUser: true
            });
        }

        const accessToken = user.generateAccessToken();

        const refreshToken = user.generateRefreshToken();

        const userIdStr = user._id.toString();

        const userPayload = {
            _id: user._id.toString(),
            email: user.email,
            name: user.name,
            role: user.role,
            phone: user.phone,
            joinedNGOs: user.joinedNGOs ?? [], // Optional chaining / Nullish coalescing
            verificationStatus: 'APPROVED'
        };

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

export {
    userRegistrationController,
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
    googleAuthController
};