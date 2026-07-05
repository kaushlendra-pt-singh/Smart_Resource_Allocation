import { userModel } from "../models/user.model.ts";
import jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import bcrypt from "bcrypt";


//No refresh token rotation yet implemented.

const userRegistrationController = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { name, email, password, phone, role, ngoId, isActive, isVerified } = req.body;

        if (!name || !email || !password || !phone || !role) {
            return res.status(400).json({ message: "All core fields are required.", status: "failed" });
        }
        if (role === "SUPER_ADMIN") {
            return res.status(400).json({ "message": "Bad manners!" });
        }

        const defaultIsVerified = role === "RESIDENT";

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
            role,
            ngoId: role === "SUPER_ADMIN" || role === "RESIDENT" ? null : ngoId,
            isActive,
            isVerified: defaultIsVerified
        });
        const accessToken = jwt.sign(
            { userId: user._id, role: user.role, ngoId: user.ngoId },
            process.env.JWT_ACCESS_SECRET!,
            { expiresIn: '5m' }
        );

        const refreshToken = jwt.sign(
            { userId: user._id },
            process.env.JWT_REFRESH_SECRET!,
            { expiresIn: '7d' }
        );

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
                    isVerified: user.isVerified
                },
                accessToken
            });
    } catch (error: any) {
        console.error("Error in user registration", error);
        return res.status(500).json({ "message": "Internal server error in user registration." });
    }
}

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

        const newAccessToken = jwt.sign(
            { userId: user._id, role: user.role, ngoid: user.ngoId },
            process.env.JWT_REFRESH_SECRET!,
            { expiresIn: "15m" }
        )

        return res.status(200).json({
            status: "success",
            accessToken: newAccessToken
        });
    } catch (error) {
        console.error("Error inside token rotation:", error);
        return res.status(500).json({ "message": "Internal server error in refresh token controller" });
    }
}

const userLoginController = async (req: Request, res: Response): Promise<Response> => {
    try {

        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ "message": "Provide both email and password!" });

        const user = await userModel.findOne({ email }).select("+passwordHash");
        if (!user) return res.status(404).json({ "message": "No user found!", "status": "failed" });
        if (!user.isActive) return res.status(403).json({ message: "Account suspended!", status: "failed" });

        const isPassValid = bcrypt.compare(password, user.passwordHash);
        if (!isPassValid) return res.status(400).json({ message: "Invalid email or password!", status: "failed" });


        const accessToken = jwt.sign(
            { userId: user._id, role: user.role, ngoId: user.ngoId },
            process.env.JWT_ACCESS_SECRET!,
            { expiresIn: "15m" }
        );

        const refreshToken = jwt.sign(
            { userId: user._id },
            process.env.JWT_REFRESH_SECRET!,
            { expiresIn: "7d" }
        );
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
                    isVerified: user.isVerified
                },
                accessToken
            });
    } catch (error) {
        console.error("Error in user login:", error);
        return res.status(500).json({ message: "Internal server error during login." });
    }
}

export { userRegistrationController, userRefreshTokenController, userLoginController };