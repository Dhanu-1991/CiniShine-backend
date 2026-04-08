import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../../models/user.model.js";
import dotenv from 'dotenv';
import { setAuthCookies } from "./services/cookieHelper.js";
dotenv.config();

const Signup = async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { userName, contact, password } = req.body;
        // Check if user exists
        const existingUser = await User.findOne({ contact });
        if (existingUser) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: "User already exists" });
        }
        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await User.create([{ userName, contact, password: hashedPassword }], { session });

        await session.commitTransaction();
        session.endSession();

        // Set httpOnly auth cookies
        setAuthCookies(res, newUser[0]);

        res.status(200).json({
            success: true,
            message: "Signup Successful",
            user: newUser[0],
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Signup Error:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
}
export { Signup }