import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../../models/user.model.js";
import jwt from "jsonwebtoken";
import dotenv from 'dotenv';
dotenv.config();

const Signup = async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { userName, contact, password } = req.body;
        // Check if user exists
        const existingUser = await User.findOne({ contact });
        if (existingUser) {
            const error = new Error(`user already exist`);
            error.statuscode = 400;
            throw error;
        }
        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await User.create([{ userName, contact, password: hashedPassword }], { session });
        const token = jwt.sign({ userId: newUser[0]._id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRATION });
        await session.commitTransaction();
        session.endSession();
        res.status(200).json({ success: true, message: "Signup Successful", token, user: newUser[0] });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        res.status(500).json({ success: false, message: "Internal Server Error" });
        next(error);
    }
}
export { Signup }