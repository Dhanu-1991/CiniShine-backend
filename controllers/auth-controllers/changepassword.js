import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../../models/user.model.js";
import dotenv from 'dotenv';
import { setAuthCookies } from "./services/cookieHelper.js";
dotenv.config();

const changePassword = async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { contact, newPassword } = req.body;
        if (!contact || !newPassword) {
            return res.status(400).json({ message: 'Contact and new password are required' });
        }
        // Case-insensitive contact lookup
        const escapedContact = contact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const user = await User.findOne({ contact: { $regex: new RegExp(`^${escapedContact}$`, 'i') } });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        user.password = hashedPassword;

        // Increment tokenVersion to invalidate all existing refresh tokens
        user.tokenVersion = (user.tokenVersion || 0) + 1;

        await user.save();
        await session.commitTransaction();
        session.endSession();

        // Set new auth cookies
        setAuthCookies(res, user);

        res.status(200).json({
            success: true,
            message: "Password updated successfully",
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Change password error:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
}
export default changePassword;