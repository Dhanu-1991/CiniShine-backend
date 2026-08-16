import Referral from '../../models/referral.model.js';
import User from '../../models/user.model.js';
import ReferralSettings from '../../models/referralSettings.model.js';
import { approveReferral, rejectReferral, partialApproveReferral, getReferralSettings } from '../../utils/referralService.js';
import crypto from 'crypto';
import OtpSession from '../../models/adminOtpSession.model.js';
import Admin from '../../models/admin.model.js';
import { sendOtpToEmail } from '../auth-controllers/services/otpServiceEmail.js';
import { sendOtpToPhone } from '../auth-controllers/services/otpServicePhone.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 30 * 1000;
const MAX_OTP_ATTEMPTS = 3;

function hashOtp(otp) {
    return crypto.createHash('sha256').update(otp).digest('hex');
}

function detectContactType(contact) {
    return contact.includes('@') ? 'email' : 'sms';
}

function maskContact(contact, channel) {
    if (channel === 'email') {
        const [user, domain] = contact.split('@');
        return `${user.slice(0, 2)}***@${domain}`;
    }
    return `***${contact.slice(-4)}`;
}

// GET /api/admin/referrals
export const listReferrals = async (req, res) => {
    try {
        const { page = 1, limit = 10, status, search } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);

        let query = {};
        if (status) {
            query.status = status;
        }

        let referralsQuery = Referral.find(query)
            .populate('referrerId', 'userName channelName contact profilePicture')
            .populate('referredUserId', 'userName channelName contact profilePicture')
            .sort({ createdAt: -1 });

        const referrals = await referralsQuery.lean();

        let filteredReferrals = referrals;

        if (search) {
            const searchLower = search.toLowerCase();
            filteredReferrals = referrals.filter(ref => {
                const referrer = ref.referrerId || {};
                const referred = ref.referredUserId || {};
                return (referrer.userName && referrer.userName.toLowerCase().includes(searchLower)) ||
                       (referred.userName && referred.userName.toLowerCase().includes(searchLower));
            });
        }

        const total = filteredReferrals.length;
        const pages = Math.ceil(total / limitNum);

        const paginatedReferrals = filteredReferrals.slice((pageNum - 1) * limitNum, pageNum * limitNum);

        res.json({
            success: true,
            referrals: paginatedReferrals,
            total,
            page: pageNum,
            pages
        });
    } catch (err) {
        console.error('[ADMIN_LIST_REFERRALS]', err.message);
        res.status(500).json({ success: false, message: 'Failed to list referrals' });
    }
};

// GET /api/admin/referrals/stats
export const getReferralStats = async (req, res) => {
    try {
        const [total, pending, contentUploaded, approved, rejected] = await Promise.all([
            Referral.countDocuments(),
            Referral.countDocuments({ status: 'pending' }),
            Referral.countDocuments({ status: 'content_uploaded' }),
            Referral.countDocuments({ status: 'approved' }),
            Referral.countDocuments({ status: 'rejected' }),
        ]);

        const creditAgg = await Referral.aggregate([
            { $match: { status: 'approved' } },
            { $group: { _id: null, total: { $sum: { $add: [{ $ifNull: ['$referrerBonusAmount', 25] }, { $ifNull: ['$referredBonusAmount', 25] }] } } } }
        ]);
        const totalCredited = creditAgg.length > 0 ? creditAgg[0].total : 0;
        
        const settings = await getReferralSettings();

        res.json({
            success: true,
            total,
            pending,
            contentUploaded,
            approved,
            rejected,
            totalCredited,
            settings
        });
    } catch (err) {
        console.error('[ADMIN_REFERRAL_STATS]', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch referral stats' });
    }
};

// GET /api/admin/referrals/:id
export const getReferralDetail = async (req, res) => {
    try {
        const referral = await Referral.findById(req.params.id)
            .populate('referrerId', 'userName channelName contact profilePicture emailVerified')
            .populate('referredUserId', 'userName channelName contact profilePicture emailVerified createdAt')
            .lean();

        if (!referral) {
            return res.status(404).json({ success: false, message: 'Referral not found' });
        }

        res.json({ success: true, referral });
    } catch (err) {
        console.error('[ADMIN_REFERRAL_DETAIL]', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch referral details' });
    }
};

// POST /api/admin/referrals/:id/approve
export const handleApproveReferral = async (req, res) => {
    try {
        await approveReferral(req.params.id, req.admin._id);
        res.json({ success: true, message: 'Referral approved successfully' });
    } catch (err) {
        console.error('[ADMIN_APPROVE_REFERRAL]', err.message);
        res.status(400).json({ success: false, message: err.message || 'Failed to approve referral' });
    }
};

// POST /api/admin/referrals/:id/partial-approve
export const handlePartialApproveReferral = async (req, res) => {
    try {
        const { approveReferrer, approveReferred, rejectionReason } = req.body;
        
        // Validate: at least one must be approved
        if (!approveReferrer && !approveReferred) {
            return res.status(400).json({ success: false, message: 'At least one party must be approved. Use reject endpoint to reject both.' });
        }
        // If one is rejected, reason is required
        if ((!approveReferrer || !approveReferred) && !rejectionReason) {
            return res.status(400).json({ success: false, message: 'Rejection reason is required when rejecting one party' });
        }
        
        await partialApproveReferral(req.params.id, req.admin._id, { approveReferrer, approveReferred, rejectionReason });
        res.json({ success: true, message: 'Referral processed successfully' });
    } catch (err) {
        console.error('[ADMIN_PARTIAL_APPROVE_REFERRAL]', err.message);
        res.status(400).json({ success: false, message: err.message || 'Failed to process referral' });
    }
};

// POST /api/admin/referrals/:id/reject
export const handleRejectReferral = async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason) {
            return res.status(400).json({ success: false, message: 'Rejection reason is required' });
        }

        await rejectReferral(req.params.id, req.admin._id, reason);
        res.json({ success: true, message: 'Referral rejected successfully' });
    } catch (err) {
        console.error('[ADMIN_REJECT_REFERRAL]', err.message);
        res.status(400).json({ success: false, message: err.message || 'Failed to reject referral' });
    }
};

// GET /api/admin/referrals/settings
export const getReferralSettingsHandler = async (req, res) => {
    try {
        const settings = await ReferralSettings.getSettings();
        res.json({ success: true, settings });
    } catch (err) {
        console.error('[ADMIN_REFERRAL_SETTINGS]', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch referral settings' });
    }
};

// PUT /api/admin/referrals/settings
export const updateReferralSettingsHandler = async (req, res) => {
    try {
        const { isEnabled, referrerBonusAmount, referredBonusAmount } = req.body;
        
        const settings = await ReferralSettings.getSettings();
        
        if (typeof isEnabled === 'boolean') settings.isEnabled = isEnabled;
        if (typeof referrerBonusAmount === 'number' && referrerBonusAmount >= 0) settings.referrerBonusAmount = referrerBonusAmount;
        if (typeof referredBonusAmount === 'number' && referredBonusAmount >= 0) settings.referredBonusAmount = referredBonusAmount;
        settings.updatedBy = req.admin._id;
        settings.updatedAt = new Date();
        
        await settings.save();
        
        console.log(`[ADMIN] Referral settings updated by ${req.admin._id}: enabled=${settings.isEnabled}, referrer=${settings.referrerBonusAmount}, referred=${settings.referredBonusAmount}`);
        
        res.json({ success: true, settings, message: 'Referral settings updated successfully' });
    } catch (err) {
        console.error('[ADMIN_UPDATE_REFERRAL_SETTINGS]', err.message);
        res.status(500).json({ success: false, message: 'Failed to update referral settings' });
    }
};

// POST /api/admin/referrals/settings/send-otp
export const sendReferralSettingsOtp = async (req, res) => {
    try {
        const adminId = req.admin._id;
        const admin = await Admin.findById(adminId);
        if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });
        
        const contact = admin.contact;
        const channel = detectContactType(contact);

        // Check cooldown - look for existing referral_settings session for this admin
        const existingSession = await OtpSession.findOne({
            admin_id: adminId,
            purpose: 'referral_settings'
        }).sort({ createdAt: -1 });

        if (existingSession) {
            const ageMs = Date.now() - (existingSession.updatedAt || existingSession.createdAt).getTime();
            if (ageMs < OTP_COOLDOWN_MS) {
                return res.status(429).json({
                    success: false,
                    message: 'Please wait before requesting another OTP',
                    cooldownRemaining: Math.ceil((OTP_COOLDOWN_MS - ageMs) / 1000)
                });
            }
        }

        // Delete old sessions for this admin/purpose
        await OtpSession.deleteMany({ admin_id: adminId, purpose: 'referral_settings' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        const otpSession = await OtpSession.create({
            admin_id: adminId,
            contact,
            otp_hash: hashOtp(otp),
            channel,
            purpose: 'referral_settings',
            expires_at: new Date(Date.now() + OTP_TTL_MS)
        });

        let sent = false;
        if (channel === 'email') {
            sent = await sendOtpToEmail(contact, otp, 'referral_settings');
        } else {
            sent = await sendOtpToPhone(contact, otp);
        }

        if (!sent) {
            await OtpSession.findByIdAndDelete(otpSession._id);
            return res.status(500).json({ success: false, message: 'Failed to send OTP' });
        }

        console.log(`[ADMIN] Referral settings OTP sent to ${maskContact(contact, channel)} by admin ${adminId}`);

        res.json({
            success: true,
            message: 'OTP sent successfully',
            otpSessionId: otpSession._id,
            channel,
            maskedContact: maskContact(contact, channel),
            cooldownRemaining: Math.ceil(OTP_COOLDOWN_MS / 1000)
        });
    } catch (err) {
        console.error('[ADMIN_REFERRAL_SETTINGS_OTP]', err.message);
        res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
};

// POST /api/admin/referrals/settings/verify-otp
export const verifyReferralSettingsOtp = async (req, res) => {
    try {
        const { otpSessionId, otp, settings: pendingSettings } = req.body;
        const adminId = req.admin._id;
        
        if (!otpSessionId || !otp) {
            return res.status(400).json({ success: false, message: 'OTP session and code required' });
        }
        if (!pendingSettings) {
            return res.status(400).json({ success: false, message: 'Settings payload required' });
        }

        const session = await OtpSession.findById(otpSessionId);
        if (!session) {
            return res.status(400).json({ success: false, message: 'OTP session not found or expired' });
        }

        // Verify session belongs to this admin
        if (session.admin_id?.toString() !== adminId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized OTP session' });
        }

        if (session.purpose !== 'referral_settings') {
            return res.status(400).json({ success: false, message: 'Invalid OTP purpose' });
        }

        if (session.expires_at < new Date()) {
            await OtpSession.findByIdAndDelete(otpSessionId);
            return res.status(400).json({ success: false, message: 'OTP has expired' });
        }

        if (session.attempts >= MAX_OTP_ATTEMPTS) {
            await OtpSession.findByIdAndDelete(otpSessionId);
            return res.status(403).json({
                success: false,
                message: 'Too many failed attempts. Please request a new OTP.'
            });
        }

        const otpHash = hashOtp(otp);
        if (otpHash !== session.otp_hash) {
            session.attempts += 1;
            await session.save();
            return res.status(400).json({
                success: false,
                message: 'Invalid OTP',
                attemptsRemaining: MAX_OTP_ATTEMPTS - session.attempts
            });
        }

        // OTP verified — delete session and save settings
        await OtpSession.findByIdAndDelete(otpSessionId);

        const settingsDoc = await ReferralSettings.getSettings();
        
        if (typeof pendingSettings.isEnabled === 'boolean') settingsDoc.isEnabled = pendingSettings.isEnabled;
        if (typeof pendingSettings.referrerBonusAmount === 'number' && pendingSettings.referrerBonusAmount >= 0) settingsDoc.referrerBonusAmount = pendingSettings.referrerBonusAmount;
        if (typeof pendingSettings.referredBonusAmount === 'number' && pendingSettings.referredBonusAmount >= 0) settingsDoc.referredBonusAmount = pendingSettings.referredBonusAmount;
        settingsDoc.updatedBy = adminId;
        settingsDoc.updatedAt = new Date();
        
        await settingsDoc.save();

        console.log(`[ADMIN] Referral settings updated after OTP verification by ${adminId}: enabled=${settingsDoc.isEnabled}, referrer=${settingsDoc.referrerBonusAmount}, referred=${settingsDoc.referredBonusAmount}`);

        res.json({
            success: true,
            message: 'Settings updated successfully',
            settings: settingsDoc
        });
    } catch (err) {
        console.error('[ADMIN_VERIFY_REFERRAL_SETTINGS_OTP]', err.message);
        res.status(500).json({ success: false, message: 'Failed to verify OTP' });
    }
};
