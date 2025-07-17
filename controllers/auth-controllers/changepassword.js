import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../../models/user.model.js";
import jwt from "jsonwebtoken";
import dotenv from 'dotenv';
dotenv.config();

const changePassword = async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { contact, newPassword } = req.body;
        if (!contact || !newPassword) {
            return res.status(400).json({ message: 'Contact and new password are required' });
        }
        const user = await User.findOne({ contact });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        user.password = hashedPassword;
        await user.save();
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRATION });
        await session.commitTransaction();
        session.endSession();
        res.status(200).json({ success: true, message: "Password updated successfully", token, user });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        res.status(500).json({ success: false, message: "Internal Server Error" });
        next(error);
    }
}
export default changePassword;