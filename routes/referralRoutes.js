import express from 'express';
import { universalTokenVerifier } from '../controllers/auth-controllers/universalTokenVerifier.js';
import Referral from '../models/referral.model.js';
import User from '../models/user.model.js';
import { generateReferralCode, getReferralSettings } from '../utils/referralService.js';

const referralRouter = express.Router();

// GET /api/v2/referrals/settings — public, returns referral program status and amounts
referralRouter.get('/settings', async (req, res) => {
    try {
        const settings = await getReferralSettings();
        res.json({ 
            success: true, 
            isEnabled: settings.isEnabled,
            referrerBonusAmount: settings.referrerBonusAmount,
            referredBonusAmount: settings.referredBonusAmount,
        });
    } catch (err) {
        console.error('[REFERRAL_SETTINGS]', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch referral settings' });
    }
});

// All routes require authentication
referralRouter.use(universalTokenVerifier);

// GET /api/v2/referrals/code — get or generate referral code
referralRouter.get('/code', async (req, res) => {
    try {
        const settings = await getReferralSettings();
        if (!settings.isEnabled) {
            return res.status(403).json({ success: false, message: 'Referral program is currently disabled' });
        }
        const code = await generateReferralCode(req.user.id);
        res.json({ success: true, referralCode: code });
    } catch (err) {
        console.error('[REFERRAL_CODE]', err.message);
        res.status(500).json({ success: false, message: 'Failed to generate referral code' });
    }
});

// GET /api/v2/referrals/my-referrals — list user's own referrals
referralRouter.get('/my-referrals', async (req, res) => {
    try {
        const referrals = await Referral.find({ referrerId: req.user.id })
            .populate('referredUserId', 'userName channelName profilePicture createdAt')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, referrals });
    } catch (err) {
        console.error('[MY_REFERRALS]', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch referrals' });
    }
});

// GET /api/v2/referrals/stats — user's referral stats
referralRouter.get('/stats', async (req, res) => {
    try {
        const [total, approved, pending, contentUploaded] = await Promise.all([
            Referral.countDocuments({ referrerId: req.user.id }),
            Referral.countDocuments({ referrerId: req.user.id, status: 'approved' }),
            Referral.countDocuments({ referrerId: req.user.id, status: 'pending' }),
            Referral.countDocuments({ referrerId: req.user.id, status: 'content_uploaded' }),
        ]);
        const settings = await getReferralSettings();
        const totalEarned = approved * settings.referrerBonusAmount;
        res.json({ success: true, stats: { total, approved, pending, contentUploaded, totalEarned, referrerBonusAmount: settings.referrerBonusAmount, referredBonusAmount: settings.referredBonusAmount, isEnabled: settings.isEnabled } });
    } catch (err) {
        console.error('[REFERRAL_STATS]', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch referral stats' });
    }
});

export default referralRouter;
