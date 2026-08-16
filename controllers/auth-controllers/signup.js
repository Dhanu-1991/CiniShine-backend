import mongoose from "mongoose";
import { validatePasswordStrength } from '../../utils/passwordValidator.js';
import bcrypt from "bcryptjs";
import User from "../../models/user.model.js";
import dotenv from 'dotenv';
import { setAuthCookies } from "./services/cookieHelper.js";
import { processReferralSignup } from '../../utils/referralService.js';
import { sendWelcomeEmail } from '../../services/authEmailService.js';
dotenv.config();

const Signup = async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { userName, contact, password, referralCode } = req.body;
        // Check if user exists
        const existingUser = await User.findOne({ contact });
        if (existingUser) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: "User already exists" });
        }
        // Validate password strength
        const pwValidation = validatePasswordStrength(password);
        if (!pwValidation.valid) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: 'Password does not meet requirements',
                errors: pwValidation.errors
            });
        }
        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await User.create([{ userName, contact, password: hashedPassword }], { session });

        await session.commitTransaction();
        session.endSession();

        if (referralCode) {
            processReferralSignup(referralCode, newUser[0]._id).catch(err => {
                console.error('[SIGNUP] Referral processing error:', err.message);
            });
        }

        // Send welcome email if contact is an email address (non-blocking)
        if (contact && contact.includes('@')) {
            sendWelcomeEmail({ email: contact, userName }).catch(err => {
                console.error('[SIGNUP] Welcome email error:', err.message);
            });
        }

        // Set httpOnly auth cookies
        const { accessToken, refreshToken } = setAuthCookies(res, newUser[0]);

        res.status(200).json({
            success: true,
            message: "Signup Successful",
            accessToken,
            refreshToken,
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