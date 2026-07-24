import { userModel } from "../models/user.model.ts";
import jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { sendEmail } from "../utils/sendEmail.ts";
import { OAuth2Client } from "google-auth-library";


const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);


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


        const ifExists = await userModel.findOne({ email });
        if (ifExists) {
            console.log("User already exists.");

            return res.status(422).json({
                "message": "User with this email already exists.",
                "status": "failed"
            });
        }



        const user = await userModel.create({
            name,
            email,
            passwordHash: password,
            phone,
            role: 'RESIDENT',
            joinedNGOs: []
        });
        //Extract or populate the ids from mongoose objects
        // const ngoIdsArray = (user.joinedNGOs || [])
        const ngoIdsArray = (user.joinedNGOs || []).map(org =>
            typeof org === 'string' ? org : (org.ngoId?.toString() || org.toString())
        );

        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();

        console.log("User created successfully.");
        const cookieOptions = {
            httpOnly: true, // Prevents XSS attacks from reading the cookie
            secure: process.env.NODE_ENV === "production", // true in production (HTTPS only)
            sameSite: "strict" as const, // Prevents CSRF attacks
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
        };
        //imp: Access token goes in the JSON payload, Refresh token hides inside the secure cookie
        return res
            .cookie("refreshToken", refreshToken, cookieOptions)
            .status(201)
            .json({
                status: "success",
                user: {
                    _id: user._id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    joinedNGOs: user.joinedNGOs,
                    verificationStatus: 'APPROVED'
                },
                accessToken
            });
    } catch (error: any) {
        console.error("Error in user registration", error);
        return res.status(500).json({ "message": "Internal server error in user registration." });
    }
};

const promoteFounderController = async (req: Request, res: Response): Promise<Response> => {
    try {
        // 1. Verify Inter-Service Security
        const internalApiKey = req.headers["x-internal-key"];
        if (internalApiKey !== process.env.INTERNAL_API_KEY) {
            return res.status(403).json({
                status: "failed",
                message: "Forbidden: Access restricted to internal services."
            });
        }

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
            user.joinedNGOs.push(ngoId);
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
        // 1. Verify Inter-Service Security
        const internalApiKey = req.headers["x-internal-key"];
        if (internalApiKey !== process.env.INTERNAL_API_KEY) {
            return res.status(403).json({
                status: "failed",
                message: "Forbidden: Access restricted to internal services."
            });
        }

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

const userRefreshTokenController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { refreshToken } = req.cookies;
        if (!refreshToken) return res.status(401).json({ "message": "No RefreshToken provided." });

        let decoded: any;
        try {
            decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!);
        } catch (error) {
            return res.status(403).json({ "message": "Invalid or expired refresh token. Please login again." });
        }

        const user = await userModel.findById(decoded.userId);
        if (!user) {
            return res.status(404).json({ "message": "No user found!" });
        }
        if (!user.isActive) {
            return res.status(403).json({ "message": "This Account has been suspended!" });
        }

        const ngoIdsArray = (user.joinedNGOs || [])
            .map(org => org.ngoId?.toString())
            .filter((id): id is string => Boolean(id));

        const newAccessToken = user.generateAccessToken();

        return res.status(200).json({
            status: "success",
            accessToken: newAccessToken
        });
    } catch (error) {
        console.error("Error inside token rotation:", error);
        return res.status(500).json({ "message": "Internal server error in refresh token controller" });
    }
};

const userLoginController = async (req: Request, res: Response): Promise<Response> => {
    try {

        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ "message": "Provide both email and password!" });

        const user = await userModel.findOne({ email }).select("+passwordHash");
        if (!user) return res.status(404).json({ "message": "No user found!", "status": "failed" });
        if (!user.isActive) return res.status(403).json({ message: "Account suspended!", status: "failed" });

        const isPassValid = await bcrypt.compare(password, user.passwordHash);
        if (!isPassValid) return res.status(400).json({ message: "Invalid email or password!", status: "failed" });


        const ngoIdsArray = (user.joinedNGOs || [])
            .map(org => org.ngoId?.toString())
            .filter((id): id is string => Boolean(id));

        const accessToken = user.generateAccessToken();

        const refreshToken = user.generateRefreshToken();
        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict" as const,
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        }
        console.log(`User [${user.email}] logged in successfully.`);

        return res
            .cookie("refreshToken", refreshToken, cookieOptions)
            .status(200)
            .json({
                status: "success",
                user: {
                    _id: user._id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    joinedNGOs: user.joinedNGOs,
                    verificationStatus: user.verificationStatus
                },
                accessToken
            });
    } catch (error) {
        console.error("Error in user login:", error);
        return res.status(500).json({ message: "Internal server error during login." });
    }
};

const userLogoutController = async (req: Request, res: Response): Promise<Response> => {
    return res
        .clearCookie("refreshToken", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict" as const
        })
        .status(200)
        .json({ status: "success", message: "Logged out successfully." });
};

const getUserProfileController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const id = req.user?._id;

        // 1. Defend against missing middleware injection context
        if (!id) {
            return res.status(401).json({ message: "User context missing or unauthenticated.", status: "failed" });
        }

        // 2. Optimization: Strip away the password hash completely from the DB query return
        const user = await userModel.findById(id).select("-passwordHash -refreshTokens");

        if (!user) {
            return res.status(404).json({ message: "User profile does not exist.", status: "failed" }); // 404 is more accurate than 401 here
        }

        // 3. Optional: Verify the account hasn't been locked while they held an active token
        if (!user.isActive) {
            return res.status(403).json({ message: "Account has been suspended.", status: "failed" });
        }

        // 4. Send back a clean data object wrapper
        return res.status(200).json({
            status: "success",
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                joinedNGOs: user.joinedNGOs,
                verificationStatus: user.verificationStatus
            }
        });

    } catch (error) {
        console.error(`Error while fetching profile: ${error}`);
        return res.status(500).json({ message: "Internal server error while fetching profile." });
    }
};

const forgotPasswordController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: "Please provide an email address." });

        const user = await userModel.findOne({ email });
        if (!user) {
            //imp wtf Security Tip: Return 200 even if the email doesn't exist to prevent email enumeration attacks
            return res.status(200).json({ status: "success", message: "If an account exists, a reset link has been sent." });
        }

        // Generate a random 32-byte hex token
        const resetToken = crypto.randomBytes(32).toString("hex");

        // Hash the token to save it securely in the database
        user.passwordResetToken = crypto.createHash("sha256").update(resetToken).digest("hex");
        user.passwordResetExpires = new Date(Date.now() + 15 * 60 * 1000); // Expires in 15 minutes

        await user.save({ validateBeforeSave: false });

        // Construct reset URL string
        const resetURL = `${req.protocol}://${req.get("host")}/api/auth/reset-password/${resetToken}`;
        const message = `Forgot your password? Submit a PATCH request with your new password to:\n\n${resetURL}\n\nThis link is valid for 15 minutes.`;

        try {
            await sendEmail({
                email: user.email,
                subject: "Your Password Reset Token (Valid for 15 mins)",
                message
            });

            return res.status(200).json({ status: "success", message: "Reset token sent to email!" });
        } catch (err) {
            user.passwordResetToken = undefined;
            user.passwordResetExpires = undefined;
            await user.save({ validateBeforeSave: false });
            console.error(`Error while sending email: ${err}`);
            return res.status(500).json({ message: "Error sending email. Try again later." });
        }
    } catch (error: any) {
        console.error(`Error while forgot pass: ${error}`);
        return res.status(500).json({ message: error.message });
    }
};

const resetPasswordController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ message: "Please provide your new password." });

        // Hash the token coming from the URL parameters to match against the DB record
        const tokenParam = req.params.token as string;
        if (!tokenParam) {
            return res.status(400).json({ message: "Invalid route request. Token parameter missing." });
        }
        const hashedToken = crypto.createHash("sha256").update(tokenParam).digest("hex");

        // Find user by matched token and confirm expiration time is still in the future
        const user = await userModel.findOne({
            passwordResetToken: hashedToken,
            passwordResetExpires: { $gt: new Date() }
        }).select("+passwordHash"); // Remember to explicitly select the password field!

        if (!user) {
            return res.status(400).json({ message: "Token is invalid or has expired." });
        }

        // Set the new password (your pre("save") hook will automatically run and bcrypt hash this)
        user.passwordHash = password;
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save();

        return res.status(200).json({ status: "success", message: "Password updated successfully. You can now login!" });
    } catch (error: any) {
        return res.status(500).json({ message: error.message });
    }
};

const deleteUserController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const userId = req.user?._id;

        const deletedUser = await userModel.findByIdAndDelete(userId);
        if (!deletedUser) return res.status(404).json({ message: "User not found." });

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

        // 3. Generate your standard platform tokens (matching your native login logic)
        const ngoIdsArray = (user.joinedNGOs || [])
            .map(org => org.ngoId?.toString())
            .filter((id): id is string => Boolean(id));

        const accessToken = user.generateAccessToken();

        const refreshToken = user.generateRefreshToken();

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
    userRefreshTokenController,
    userLoginController,
    userLogoutController,
    getUserProfileController,
    forgotPasswordController,
    resetPasswordController,
    deleteUserController,
    googleAuthController
};