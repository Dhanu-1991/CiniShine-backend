import Referral from '../../models/referral.model.js';
import User from '../../models/user.model.js';
import ReferralSettings from '../../models/referralSettings.model.js';
import { approveReferral, rejectReferral, getReferralSettings } from '../../utils/referralService.js';

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
