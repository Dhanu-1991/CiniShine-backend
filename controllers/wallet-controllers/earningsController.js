import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import Purchase from '../../models/purchase.model.js';
import SecondaryWallet from '../../models/secondaryWallet.model.js';
import WalletTransaction from '../../models/walletTransaction.model.js';
import { isAdminUser } from '../../utils/ppvGuard.js';

/**
 * Get Creator Earnings Metrics (Till Date + Monthly Filtered)
 * URL: GET /api/v2/wallets/earnings
 * URL: GET /api/v2/wallets/earnings/:creatorId (for admins)
 */
export const getCreatorEarnings = async (req, res) => {
    try {
        const userId = req.user?.id || req.admin?._id?.toString() || req.admin?.id;
        const isAdmin = Boolean(req.admin) || (userId ? await isAdminUser(userId) : false);

        if (!userId && !isAdmin) return res.status(401).json({ error: 'Authentication required' });

        let targetCreatorId = userId;
        const paramCreatorId = req.params.creatorId || req.params.id || req.query.creatorId;

        if (paramCreatorId) {
            if (isAdmin || paramCreatorId === userId) {
                targetCreatorId = paramCreatorId;
            } else {
                return res.status(403).json({ error: 'Permission denied' });
            }
        }

        if (!mongoose.Types.ObjectId.isValid(targetCreatorId)) {
            return res.status(400).json({ error: 'Invalid creator ID' });
        }

        const creatorObjId = new mongoose.Types.ObjectId(targetCreatorId);
        const creatorIdArray = [targetCreatorId, creatorObjId];

        // Get all content IDs owned by this creator
        const creatorContents = await Content.find({ userId: { $in: creatorIdArray } }).select('_id').lean();
        const contentObjIds = creatorContents.map(c => c._id);
        const contentStrIds = creatorContents.map(c => c._id.toString());
        const allContentIds = [...contentObjIds, ...contentStrIds];

        if (allContentIds.length === 0) {
            const currentMonthStr = new Date().toISOString().substring(0, 7);
            const emptyMonths = [];
            const nowObj = new Date();
            for (let i = 0; i < 12; i++) {
                const pastDate = new Date(Date.UTC(nowObj.getUTCFullYear(), nowObj.getUTCMonth() - i, 1));
                const yyyy = pastDate.getUTCFullYear();
                const mm = String(pastDate.getUTCMonth() + 1).padStart(2, '0');
                const mVal = `${yyyy}-${mm}`;
                emptyMonths.push({
                    value: mVal,
                    label: pastDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
                });
            }

            return res.json({
                creatorId: targetCreatorId,
                lifetime: {
                    grossSold: 0,
                    totalCuts: 0,
                    netEarnings: 0,
                    totalUnlocks: 0,
                    platformCommission: 0,
                    gstOnCommission: 0,
                    tdsDeducted: 0,
                    tcsDeducted: 0,
                },
                monthly: {
                    month: currentMonthStr,
                    grossSold: 0,
                    totalCuts: 0,
                    netEarnings: 0,
                    totalUnlocks: 0,
                    platformCommission: 0,
                    gstOnCommission: 0,
                    tdsDeducted: 0,
                    tcsDeducted: 0,
                },
                availableMonths: emptyMonths
            });
        }

        // Selected month parameter (default: current YYYY-MM)
        const currentMonthStr = new Date().toISOString().substring(0, 7);
        const selectedMonth = req.query.month || currentMonthStr;

        // Parse month range
        const [yearStr, monthStr] = selectedMonth.split('-');
        const year = parseInt(yearStr, 10);
        const month = parseInt(monthStr, 10) - 1; // 0-indexed
        const monthStart = new Date(Date.UTC(year, month, 1, 0, 0, 0));
        const monthEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));

        const purchaseMatch = {
            $or: [
                { contentId: { $in: allContentIds } },
                { creatorId: { $in: creatorIdArray } }
            ],
            status: { $in: ['active', 'expired'] }
        };

        // 1. Aggregation for Lifetime (Till Date)
        const lifetimeAgg = await Purchase.aggregate([
            { $match: purchaseMatch },
            {
                $group: {
                    _id: null,
                    totalUnlocks: { $sum: 1 },
                    grossSold: { $sum: '$amount' },
                    basePrice: { $sum: { $ifNull: ['$basePrice', { $divide: ['$amount', 1.18] }] } },
                    platformCommission: { $sum: { $ifNull: ['$platformCommission', { $multiply: ['$amount', 0.32] }] } },
                    gstOnCommission: { $sum: { $ifNull: ['$gstOnCommission', { $multiply: ['$amount', 0.0576] }] } },
                    tdsAmount: { $sum: { $ifNull: ['$tdsAmount', { $multiply: [{ $divide: ['$amount', 1.18] }, 0.001] }] } },
                    tcsAmount: { $sum: { $ifNull: ['$tcsAmount', { $multiply: [{ $divide: ['$amount', 1.18] }, 0.01] }] } },
                    creatorPayout: { $sum: { $ifNull: ['$creatorPayout', { $multiply: ['$amount', 0.61308] }] } }
                }
            }
        ]);

        // 2. Aggregation for Selected Month
        const monthlyAgg = await Purchase.aggregate([
            {
                $match: {
                    ...purchaseMatch,
                    purchasedAt: { $gte: monthStart, $lt: monthEnd }
                }
            },
            {
                $group: {
                    _id: null,
                    totalUnlocks: { $sum: 1 },
                    grossSold: { $sum: '$amount' },
                    basePrice: { $sum: { $ifNull: ['$basePrice', { $divide: ['$amount', 1.18] }] } },
                    platformCommission: { $sum: { $ifNull: ['$platformCommission', { $multiply: ['$amount', 0.32] }] } },
                    gstOnCommission: { $sum: { $ifNull: ['$gstOnCommission', { $multiply: ['$amount', 0.0576] }] } },
                    tdsAmount: { $sum: { $ifNull: ['$tdsAmount', { $multiply: [{ $divide: ['$amount', 1.18] }, 0.001] }] } },
                    tcsAmount: { $sum: { $ifNull: ['$tcsAmount', { $multiply: [{ $divide: ['$amount', 1.18] }, 0.01] }] } },
                    creatorPayout: { $sum: { $ifNull: ['$creatorPayout', { $multiply: ['$amount', 0.61308] }] } }
                }
            }
        ]);

        // 3. Find all available months with purchase history
        const monthDates = await Purchase.aggregate([
            { $match: purchaseMatch },
            {
                $project: {
                    monthStr: { $dateToString: { format: '%Y-%m', date: '$purchasedAt' } }
                }
            },
            { $group: { _id: '$monthStr' } },
            { $sort: { _id: -1 } }
        ]);

        const availableMonthStrings = new Set([currentMonthStr]);
        monthDates.forEach(m => { if (m._id) availableMonthStrings.add(m._id); });

        // Dynamically populate all months of current year + past 12 consecutive months
        const nowObj = new Date();
        const currentYear = nowObj.getUTCFullYear();
        const currentMonthIdx = nowObj.getUTCMonth();

        // 1. All months of current year (Jan..Current)
        for (let m = 0; m <= currentMonthIdx; m++) {
            const mm = String(m + 1).padStart(2, '0');
            availableMonthStrings.add(`${currentYear}-${mm}`);
        }

        // 2. Past 12 consecutive months
        for (let i = 0; i < 12; i++) {
            const pastDate = new Date(Date.UTC(currentYear, currentMonthIdx - i, 1));
            const yyyy = pastDate.getUTCFullYear();
            const mm = String(pastDate.getUTCMonth() + 1).padStart(2, '0');
            availableMonthStrings.add(`${yyyy}-${mm}`);
        }

        const availableMonths = Array.from(availableMonthStrings).sort().reverse().map(mVal => {
            const [y, m] = mVal.split('-');
            const d = new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, 1));
            return {
                value: mVal,
                label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
            };
        });

        // 4. Query engagement earnings from SecondaryWallet
        const secondaryWallet = await SecondaryWallet.findOne({ userId: targetCreatorId }).select('_id').lean();
        let lifetimeEngagementEarnings = 0;
        let monthlyEngagementEarnings = 0;

        if (secondaryWallet) {
            const lifetimeEngAgg = await WalletTransaction.aggregate([
                { $match: { walletId: secondaryWallet._id, type: 'engagement_earning_credit', status: 'completed' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]);
            if (lifetimeEngAgg[0]) lifetimeEngagementEarnings = lifetimeEngAgg[0].total;

            const monthlyEngAgg = await WalletTransaction.aggregate([
                { 
                    $match: { 
                        walletId: secondaryWallet._id, 
                        type: 'engagement_earning_credit', 
                        status: 'completed',
                        createdAt: { $gte: monthStart, $lt: monthEnd }
                    } 
                },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]);
            if (monthlyEngAgg[0]) monthlyEngagementEarnings = monthlyEngAgg[0].total;
        }

        const lData = lifetimeAgg[0] || {};
        const lGross = lData.grossSold || 0;
        const lComm = lData.platformCommission || 0;
        const lGstComm = lData.gstOnCommission || 0;
        const lTds = lData.tdsAmount || 0;
        const lTcs = lData.tcsAmount || 0;
        const lCuts = lComm + lGstComm + lTds + lTcs;
        const lNet = lData.creatorPayout || (lGross - lCuts);

        const mData = monthlyAgg[0] || {};
        const mGross = mData.grossSold || 0;
        const mComm = mData.platformCommission || 0;
        const mGstComm = mData.gstOnCommission || 0;
        const mTds = mData.tdsAmount || 0;
        const mTcs = mData.tcsAmount || 0;
        const mCuts = mComm + mGstComm + mTds + mTcs;
        const mNet = mData.creatorPayout || (mGross - mCuts);

        res.json({
            creatorId: targetCreatorId,
            lifetime: {
                grossSold: parseFloat(lGross.toFixed(2)),
                totalCuts: parseFloat(lCuts.toFixed(2)),
                netEarnings: parseFloat(lNet.toFixed(2)),
                engagementEarnings: parseFloat(lifetimeEngagementEarnings.toFixed(2)),
                totalCreatorEarnings: parseFloat((lNet + lifetimeEngagementEarnings).toFixed(2)),
                totalUnlocks: lData.totalUnlocks || 0,
                platformCommission: parseFloat(lComm.toFixed(2)),
                gstOnCommission: parseFloat(lGstComm.toFixed(2)),
                tdsDeducted: parseFloat(lTds.toFixed(2)),
                tcsDeducted: parseFloat(lTcs.toFixed(2)),
            },
            monthly: {
                month: selectedMonth,
                grossSold: parseFloat(mGross.toFixed(2)),
                totalCuts: parseFloat(mCuts.toFixed(2)),
                netEarnings: parseFloat(mNet.toFixed(2)),
                engagementEarnings: parseFloat(monthlyEngagementEarnings.toFixed(2)),
                totalCreatorEarnings: parseFloat((mNet + monthlyEngagementEarnings).toFixed(2)),
                totalUnlocks: mData.totalUnlocks || 0,
                platformCommission: parseFloat(mComm.toFixed(2)),
                gstOnCommission: parseFloat(mGstComm.toFixed(2)),
                tdsDeducted: parseFloat(mTds.toFixed(2)),
                tcsDeducted: parseFloat(mTcs.toFixed(2)),
            },
            availableMonths
        });
    } catch (error) {
        console.error('❌ Error fetching creator earnings:', error);
        res.status(500).json({ error: 'Failed to fetch earnings' });
    }
};
