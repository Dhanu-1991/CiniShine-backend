import mongoose from "mongoose";
import { validatePasswordStrength } from '../../utils/passwordValidator.js';
import bcrypt from "bcryptjs";
import User from "../../models/user.model.js";
import dotenv from 'dotenv';
import { setAuthCookies } from "./services/cookieHelper.js";
import { saveOtp, getOtp, deleteOtp, isVerified, clearVerified } from "./services/otpStore.js";
import { sendOtpToEmail } from "./services/otpServiceEmail.js";
import { sendOtpToPhone } from "./services/otpServicePhone.js";

dotenv.config();

const maskContact = (contact) => {
    if (!contact) return '';
    const str = String(contact).trim();
    if (str.includes('@')) {
        const [local, domain] = str.split('@');
        if (local.length <= 3) {
            return `${local.charAt(0)}***@${domain}`;
        }
        return `${local.slice(0, 3)}***@${domain}`;
    }
    if (str.length > 6) {
        return `${str.slice(0, 4)}****${str.slice(-3)}`;
    }
    return str;
};

/**
 * Public/Forgot-Password: Change password after OTP verification
 */
const changePassword = async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { contact, newPassword, otp } = req.body;
        if (!contact || !newPassword) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: 'Contact and new password are required' });
        }
        // Validate password strength
        const pwValidation = validatePasswordStrength(newPassword);
        if (!pwValidation.valid) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: 'Password does not meet requirements',
                errors: pwValidation.errors
            });
        }
        // Case-insensitive contact lookup
        const escapedContact = contact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const user = await User.findOne({ contact: { $regex: new RegExp(`^${escapedContact}$`, 'i') } }).session(session);
        if (!user) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Verify that OTP was verified or matches directly
        const verified = isVerified(user.contact);
        const actualOtp = getOtp(user.contact);
        const otpMatches = otp && actualOtp && actualOtp === String(otp).trim();

        if (!verified && !otpMatches) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: 'Please verify the OTP before resetting your password.'
            });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        user.password = hashedPassword;

        // Increment tokenVersion to invalidate all existing refresh tokens
        user.tokenVersion = (user.tokenVersion || 0) + 1;

        await user.save({ session });
        await session.commitTransaction();
        session.endSession();

        // Clear verification record
        clearVerified(user.contact);
        deleteOtp(user.contact);

        // Set new auth cookies
        setAuthCookies(res, user);

        return res.status(200).json({
            success: true,
            message: "Password updated successfully",
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Change password error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * Authenticated: Send OTP before changing password in /settings
 */
export const sendChangePasswordOtp = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { newPassword } = req.body;

        if (!userId) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (newPassword) {
            const pwValidation = validatePasswordStrength(newPassword);
            if (!pwValidation.valid) {
                return res.status(400).json({
                    success: false,
                    message: 'New password does not meet requirements',
                    errors: pwValidation.errors
                });
            }
            if (user.password) {
                const isSame = await bcrypt.compare(newPassword, user.password);
                if (isSame) {
                    return res.status(400).json({
                        success: false,
                        message: 'New password cannot be the same as your current password'
                    });
                }
            }
        }

        const contact = user.contact;
        const isEmailContact = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        try {
            saveOtp(contact, otp);
        } catch (err) {
            if (err.statusCode === 429) {
                return res.status(429).json({
                    success: false,
                    message: err.message,
                    retryAfterSec: err.retryAfterSec,
                    maskedContact: maskContact(contact)
                });
            }
            throw err;
        }

        if (isEmailContact) {
            const sent = await sendOtpToEmail(contact, otp, 'changePassword');
            if (!sent) {
                return res.status(500).json({ success: false, message: 'Failed to send OTP to your registered email' });
            }
        } else {
            const sent = await sendOtpToPhone(contact, otp);
            if (!sent) {
                return res.status(500).json({ success: false, message: 'Failed to send OTP to your phone' });
            }
        }

        return res.status(200).json({
            success: true,
            message: `Verification code sent to ${maskContact(contact)}. Valid for 5 minutes.`,
            maskedContact: maskContact(contact),
            cooldownSec: 30
        });
    } catch (error) {
        console.error("sendChangePasswordOtp error:", error);
        return res.status(500).json({ success: false, message: "Failed to send verification code. Please try again." });
    }
};

/**
 * Authenticated: Save new password after OTP verification in /settings
 */
export const changePasswordAuth = async (req, res) => {
    const userId = req.user?.id;
    const { newPassword, otp } = req.body;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (!newPassword) {
        return res.status(400).json({ success: false, message: 'New password is required' });
    }
    if (!otp || String(otp).trim().length !== 6) {
        return res.status(400).json({ success: false, message: 'Valid 6-digit verification code is required' });
    }

    const pwValidation = validatePasswordStrength(newPassword);
    if (!pwValidation.valid) {
        return res.status(400).json({
            success: false,
            message: 'Password does not meet requirements',
            errors: pwValidation.errors
        });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const user = await User.findById(userId).session(session);
        if (!user) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.password) {
            const isSame = await bcrypt.compare(newPassword, user.password);
            if (isSame) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({
                    success: false,
                    message: 'New password cannot be the same as your current password'
                });
            }
        }

        // Verify OTP
        const actualOtp = getOtp(user.contact);
        if (!actualOtp) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: 'Verification code has expired or was not requested. Please request a new code.'
            });
        }

        if (actualOtp !== String(otp).trim()) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: 'Invalid verification code. Please check and try again.'
            });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        user.password = hashedPassword;
        user.tokenVersion = (user.tokenVersion || 0) + 1;

        await user.save({ session });
        await session.commitTransaction();
        session.endSession();

        // Delete used OTP
        deleteOtp(user.contact);

        // Refresh auth cookies
        setAuthCookies(res, user);

        return res.status(200).json({
            success: true,
            message: 'Password updated successfully',
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Authenticated change password error:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

export default changePassword;