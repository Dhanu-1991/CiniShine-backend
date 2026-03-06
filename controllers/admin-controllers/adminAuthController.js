import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import Admin from '../../models/admin.model.js';
import OtpSession from '../../models/adminOtpSession.model.js';
import AdminRequest from '../../models/adminRequest.model.js';
import AdminAuditLog from '../../models/adminAuditLog.model.js';
import AdminNotification from '../../models/adminNotification.model.js';
import { sendOtpToEmail } from '../auth-controllers/services/otpServiceEmail.js';
import { sendOtpToPhone } from '../auth-controllers/services/otpServicePhone.js';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OTP_ATTEMPTS = 3;
const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_MIN_LENGTH = 8;

function getClientIp(req) {
    return req.ip || req.connection?.remoteAddress || '';
}

function detectContactType(contact) {
    // Simple heuristic: if contains @, it's email; otherwise phone
    return contact.includes('@') ? 'email' : 'sms';
}

/**
 * Helper to hash OTP (store hashed, never plaintext)
 */
function hashOtp(otp) {
    return crypto.createHash('sha256').update(otp).digest('hex');
}

/**
 * POST /admin/signin
 * Step 1: Validate contact + password → send OTP
 */
export const adminSignin = async (req, res) => {
    try {
        const { contact, password } = req.body;
        if (!contact || !password) {
            return res.status(400).json({ success: false, message: 'Contact and password are required' });
        }

        const admin = await Admin.findOne({ contact: contact.toLowerCase().trim() });
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        if (admin.status === 'pending') {
            return res.status(403).json({ success: false, message: 'Account pending approval' });
        }
        if (admin.status === 'blocked') {
            return res.status(403).json({ success: false, message: 'Account is blocked' });
        }
        if (admin.locked_until && admin.locked_until > new Date()) {
            return res.status(403).json({
                success: false,
                message: 'Account is locked due to failed attempts',
                locked_until: admin.locked_until
            });
        }

        const isMatch = await bcrypt.compare(password, admin.password_hash);
        if (!isMatch) {
            admin.failed_attempts_count += 1;

            if (admin.failed_attempts_count >= MAX_LOGIN_ATTEMPTS) {
                admin.locked_until = new Date(Date.now() + LOCKOUT_DURATION_MS);
                admin.failed_attempts_count = 0;
                await admin.save();

                // Create notification for all admins
                await AdminNotification.create({
                    type: 'account_locked',
                    title: 'Admin Account Locked',
                    message: `Admin "${admin.name}" (${admin.contact}) locked due to ${MAX_LOGIN_ATTEMPTS} failed login attempts.`,
                    severity: 'critical',
                    metadata: { admin_id: admin._id }
                });

                await AdminAuditLog.create({
                    admin_id: admin._id,
                    action: 'login_locked',
                    target_type: 'admin',
                    target_id: admin._id,
                    ip: getClientIp(req),
                    user_agent: req.headers['user-agent'] || '',
                    note: 'Account locked after 3 failed password attempts'
                });

                return res.status(403).json({
                    success: false,
                    message: 'Account locked for 24 hours due to too many failed attempts'
                });
            }

            await admin.save();

            await AdminAuditLog.create({
                admin_id: admin._id,
                action: 'login_failed',
                target_type: 'admin',
                target_id: admin._id,
                ip: getClientIp(req),
                user_agent: req.headers['user-agent'] || '',
                note: `Failed password attempt (${admin.failed_attempts_count}/${MAX_LOGIN_ATTEMPTS})`
            });

            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Password correct — send OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const channel = detectContactType(admin.contact);

        // Delete any existing OTP sessions for this admin login
        await OtpSession.deleteMany({ contact: admin.contact, purpose: 'login' });

        const otpSession = await OtpSession.create({
            admin_id: admin._id,
            contact: admin.contact,
            otp_hash: hashOtp(otp),
            channel,
            purpose: 'login',
            expires_at: new Date(Date.now() + OTP_TTL_MS)
        });

        // Send OTP
        let sent = false;
        if (channel === 'email') {
            sent = await sendOtpToEmail(admin.contact, otp);
        } else {
            sent = await sendOtpToPhone(admin.contact, otp);
        }

        if (!sent) {
            return res.status(500).json({ success: false, message: 'Failed to send OTP' });
        }

        await AdminAuditLog.create({
            admin_id: admin._id,
            action: 'otp_sent',
            target_type: 'admin',
            target_id: admin._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || ''
        });

        return res.status(200).json({
            success: true,
            needsOtp: true,
            otpSessionId: otpSession._id,
            channel,
            maskedContact: maskContact(admin.contact, channel)
        });
    } catch (error) {
        console.error('Admin signin error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/verify-otp
 * Step 2: Verify OTP → return JWT
 */
export const adminVerifyOtp = async (req, res) => {
    try {
        const { otpSessionId, otp } = req.body;
        if (!otpSessionId || !otp) {
            return res.status(400).json({ success: false, message: 'OTP session and code required' });
        }

        const session = await OtpSession.findById(otpSessionId);
        if (!session) {
            return res.status(400).json({ success: false, message: 'OTP session not found or expired' });
        }

        if (session.expires_at < new Date()) {
            await OtpSession.findByIdAndDelete(otpSessionId);
            return res.status(400).json({ success: false, message: 'OTP has expired' });
        }

        if (session.attempts >= MAX_OTP_ATTEMPTS) {
            await OtpSession.findByIdAndDelete(otpSessionId);

            // Lock account if this was a login OTP
            if (session.admin_id) {
                const admin = await Admin.findById(session.admin_id);
                if (admin) {
                    admin.locked_until = new Date(Date.now() + LOCKOUT_DURATION_MS);
                    admin.failed_attempts_count = 0;
                    await admin.save();

                    await AdminNotification.create({
                        type: 'account_locked',
                        title: 'Admin Account Locked (OTP)',
                        message: `Admin "${admin.name}" locked due to ${MAX_OTP_ATTEMPTS} failed OTP attempts.`,
                        severity: 'critical',
                        metadata: { admin_id: admin._id }
                    });

                    await AdminAuditLog.create({
                        admin_id: admin._id,
                        action: 'login_locked',
                        target_type: 'admin',
                        target_id: admin._id,
                        ip: getClientIp(req),
                        user_agent: req.headers['user-agent'] || '',
                        note: 'Account locked after 3 failed OTP attempts'
                    });
                }
            }

            return res.status(403).json({
                success: false,
                message: 'Too many failed OTP attempts. Account locked for 24 hours.'
            });
        }

        const otpHash = hashOtp(otp);
        if (otpHash !== session.otp_hash) {
            session.attempts += 1;
            await session.save();

            if (session.admin_id) {
                await AdminAuditLog.create({
                    admin_id: session.admin_id,
                    action: 'otp_failed',
                    target_type: 'admin',
                    target_id: session.admin_id,
                    ip: getClientIp(req),
                    user_agent: req.headers['user-agent'] || '',
                    note: `OTP attempt ${session.attempts}/${MAX_OTP_ATTEMPTS}`
                });
            }

            return res.status(400).json({
                success: false,
                message: 'Invalid OTP',
                attemptsRemaining: MAX_OTP_ATTEMPTS - session.attempts
            });
        }

        // OTP correct — cleanup and issue token
        await OtpSession.findByIdAndDelete(otpSessionId);

        // Handle different purposes
        if (session.purpose === 'login') {
            const admin = await Admin.findById(session.admin_id);
            if (!admin || admin.status !== 'active') {
                return res.status(403).json({ success: false, message: 'Account not active' });
            }

            // Reset failed attempts and update last login
            admin.failed_attempts_count = 0;
            admin.locked_until = null;
            admin.last_login_at = new Date();
            await admin.save();

            const token = jwt.sign(
                { adminId: admin._id, role: admin.role },
                process.env.JWT_SECRET,
                { expiresIn: '8h' }
            );

            await AdminAuditLog.create({
                admin_id: admin._id,
                action: 'login',
                target_type: 'admin',
                target_id: admin._id,
                ip: getClientIp(req),
                user_agent: req.headers['user-agent'] || ''
            });

            return res.status(200).json({
                success: true,
                message: 'Login successful',
                token,
                admin: {
                    id: admin._id,
                    name: admin.name,
                    contact: admin.contact,
                    role: admin.role
                }
            });
        }

        if (session.purpose === 'signup') {
            // OTP verified for signup — mark as verified in metadata
            return res.status(200).json({
                success: true,
                message: 'OTP verified for signup',
                verified: true,
                contact: session.contact
            });
        }

        if (session.purpose === 'forgot_password') {
            // OTP verified for password reset — return a short-lived reset token
            const resetToken = jwt.sign(
                { contact: session.contact, purpose: 'password_reset' },
                process.env.JWT_SECRET,
                { expiresIn: '10m' }
            );

            return res.status(200).json({
                success: true,
                message: 'OTP verified. You may now reset your password.',
                resetToken
            });
        }

        return res.status(400).json({ success: false, message: 'Unknown OTP purpose' });
    } catch (error) {
        console.error('Admin verify OTP error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/signup
 * Register new admin — sends OTP, creates pending admin after OTP verification.
 */
export const adminSignup = async (req, res) => {
    try {
        const { name, contact, password, otpVerified } = req.body;
        if (!name || !contact || !password) {
            return res.status(400).json({ success: false, message: 'Name, contact, and password are required' });
        }

        if (password.length < PASSWORD_MIN_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
            });
        }

        const normalizedContact = contact.toLowerCase().trim();
        const existing = await Admin.findOne({ contact: normalizedContact });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Admin with this contact already exists' });
        }

        // Step 1: If not OTP-verified yet, send OTP
        if (!otpVerified) {
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const channel = detectContactType(normalizedContact);

            await OtpSession.deleteMany({ contact: normalizedContact, purpose: 'signup' });

            const otpSession = await OtpSession.create({
                contact: normalizedContact,
                otp_hash: hashOtp(otp),
                channel,
                purpose: 'signup',
                expires_at: new Date(Date.now() + OTP_TTL_MS)
            });

            let sent = false;
            if (channel === 'email') {
                sent = await sendOtpToEmail(normalizedContact, otp);
            } else {
                sent = await sendOtpToPhone(normalizedContact, otp);
            }

            if (!sent) {
                return res.status(500).json({ success: false, message: 'Failed to send OTP' });
            }

            return res.status(200).json({
                success: true,
                needsOtp: true,
                otpSessionId: otpSession._id,
                channel,
                maskedContact: maskContact(normalizedContact, channel)
            });
        }

        // Step 2: OTP verified — create pending admin
        const salt = await bcrypt.genSalt(12);
        const password_hash = await bcrypt.hash(password, salt);

        const admin = await Admin.create({
            name: name.trim(),
            contact: normalizedContact,
            password_hash,
            role: 'admin',
            status: 'pending'
        });

        // Create approval request
        await AdminRequest.create({
            requester_contact: normalizedContact,
            type: 'signup',
            reason: `New admin signup: ${name.trim()}`
        });

        // Notify existing admins
        await AdminNotification.create({
            type: 'new_signup_pending',
            title: 'New Admin Signup Pending',
            message: `"${name.trim()}" (${normalizedContact}) has signed up and needs approval.`,
            severity: 'warning',
            metadata: { admin_id: admin._id }
        });

        return res.status(201).json({
            success: true,
            message: 'Signup submitted. Awaiting admin approval.',
            admin: {
                id: admin._id,
                name: admin.name,
                contact: admin.contact,
                status: admin.status
            }
        });
    } catch (error) {
        console.error('Admin signup error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/resend-otp
 * Resend OTP for an existing session (throttled).
 */
export const adminResendOtp = async (req, res) => {
    try {
        const { otpSessionId } = req.body;
        if (!otpSessionId) {
            return res.status(400).json({ success: false, message: 'OTP session ID required' });
        }

        const session = await OtpSession.findById(otpSessionId);
        if (!session) {
            return res.status(400).json({ success: false, message: 'OTP session not found or expired' });
        }

        // Throttle: only allow resend if session was created >60s ago
        const ageMs = Date.now() - session.createdAt.getTime();
        if (ageMs < 60000) {
            return res.status(429).json({
                success: false,
                message: 'Please wait before requesting another OTP',
                retryAfterMs: 60000 - ageMs
            });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Update session with new OTP and reset expiry
        session.otp_hash = hashOtp(otp);
        session.attempts = 0;
        session.expires_at = new Date(Date.now() + OTP_TTL_MS);
        await session.save();

        let sent = false;
        if (session.channel === 'email') {
            sent = await sendOtpToEmail(session.contact, otp);
        } else {
            sent = await sendOtpToPhone(session.contact, otp);
        }

        if (!sent) {
            return res.status(500).json({ success: false, message: 'Failed to resend OTP' });
        }

        return res.status(200).json({
            success: true,
            message: 'OTP resent successfully',
            channel: session.channel,
            maskedContact: maskContact(session.contact, session.channel)
        });
    } catch (error) {
        console.error('Admin resend OTP error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/forgot-password-request
 * Admin requests activation of forgot-password (hidden UI feature).
 */
export const forgotPasswordRequest = async (req, res) => {
    try {
        const { contact, reason } = req.body;
        if (!contact || !reason) {
            return res.status(400).json({ success: false, message: 'Contact and reason are required' });
        }

        const normalizedContact = contact.toLowerCase().trim();
        const admin = await Admin.findOne({ contact: normalizedContact });
        if (!admin) {
            // Don't reveal whether admin exists
            return res.status(200).json({
                success: true,
                message: 'If an account exists, a forgot-password request has been submitted.'
            });
        }

        // Check for existing pending request
        const existingRequest = await AdminRequest.findOne({
            requester_contact: normalizedContact,
            type: 'forgot_password_activation',
            status: 'pending'
        });
        if (existingRequest) {
            return res.status(400).json({
                success: false,
                message: 'A forgot-password request is already pending.'
            });
        }

        await AdminRequest.create({
            requester_contact: normalizedContact,
            type: 'forgot_password_activation',
            reason: reason.trim()
        });

        await AdminNotification.create({
            type: 'forgot_password_request',
            title: 'Forgot Password Request',
            message: `Admin "${admin.name}" (${normalizedContact}) requested password reset. Reason: ${reason.trim()}`,
            severity: 'warning',
            metadata: { admin_id: admin._id }
        });

        return res.status(200).json({
            success: true,
            message: 'If an account exists, a forgot-password request has been submitted.'
        });
    } catch (error) {
        console.error('Forgot password request error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/forgot-password-approve
 * SuperAdmin approves forgot-password → sends OTP to the admin.
 */
export const forgotPasswordApprove = async (req, res) => {
    try {
        const { requestId } = req.body;
        if (!requestId) {
            return res.status(400).json({ success: false, message: 'Request ID required' });
        }

        const request = await AdminRequest.findById(requestId);
        if (!request || request.type !== 'forgot_password_activation' || request.status !== 'pending') {
            return res.status(404).json({ success: false, message: 'Request not found or already processed' });
        }

        const admin = await Admin.findOne({ contact: request.requester_contact });
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin account not found' });
        }

        // Approve the request
        request.status = 'approved';
        request.reviewed_by_admin = req.admin._id;
        await request.save();

        // Send OTP to admin for password reset
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const channel = detectContactType(admin.contact);

        await OtpSession.deleteMany({ contact: admin.contact, purpose: 'forgot_password' });

        const otpSession = await OtpSession.create({
            admin_id: admin._id,
            contact: admin.contact,
            otp_hash: hashOtp(otp),
            channel,
            purpose: 'forgot_password',
            expires_at: new Date(Date.now() + OTP_TTL_MS)
        });

        let sent = false;
        if (channel === 'email') {
            sent = await sendOtpToEmail(admin.contact, otp);
        } else {
            sent = await sendOtpToPhone(admin.contact, otp);
        }

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'forgot_password_approved',
            target_type: 'admin',
            target_id: admin._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: `Approved forgot-password for ${admin.contact}`
        });

        return res.status(200).json({
            success: true,
            message: `Forgot-password approved. OTP sent to ${maskContact(admin.contact, channel)}.`,
            otpSessionId: otpSession._id
        });
    } catch (error) {
        console.error('Forgot password approve error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/reset-password
 * Reset password using the reset token from OTP verification.
 */
export const adminResetPassword = async (req, res) => {
    try {
        const { resetToken, newPassword } = req.body;
        if (!resetToken || !newPassword) {
            return res.status(400).json({ success: false, message: 'Reset token and new password required' });
        }

        if (newPassword.length < PASSWORD_MIN_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
            });
        }

        let decoded;
        try {
            decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
        } catch {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        }

        if (decoded.purpose !== 'password_reset') {
            return res.status(400).json({ success: false, message: 'Invalid reset token' });
        }

        const admin = await Admin.findOne({ contact: decoded.contact });
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        const salt = await bcrypt.genSalt(12);
        admin.password_hash = await bcrypt.hash(newPassword, salt);
        admin.locked_until = null;
        admin.failed_attempts_count = 0;
        await admin.save();

        await AdminAuditLog.create({
            admin_id: admin._id,
            action: 'forgot_password_reset',
            target_type: 'admin',
            target_id: admin._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || ''
        });

        return res.status(200).json({ success: true, message: 'Password reset successful. You may now sign in.' });
    } catch (error) {
        console.error('Admin reset password error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskContact(contact, channel) {
    if (channel === 'email') {
        const [user, domain] = contact.split('@');
        if (user.length <= 2) return `${user[0]}***@${domain}`;
        return `${user[0]}${user[1]}***@${domain}`;
    }
    // Phone
    if (contact.length <= 4) return '****';
    return '****' + contact.slice(-4);
}
