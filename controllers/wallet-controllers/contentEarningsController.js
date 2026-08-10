/**
 * Content Earnings Controller
 * Per-content earnings: PPV revenue + Engagement earnings
 * URL: GET /api/v2/wallets/content/:contentId/earnings
 */
import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import Purchase from '../../models/purchase.model.js';
import WalletTransaction from '../../models/walletTransaction.model.js';
import SecondaryWallet from '../../models/secondaryWallet.model.js';

export const getContentEarnings = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { contentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Invalid content ID' });
        }

        const content = await Content.findById(contentId).select('userId visibility title contentType price isPayPerView').lean();
        if (!content) return res.status(404).json({ error: 'Content not found' });
        if (content.userId.toString() !== userId) {
            return res.status(403).json({ error: 'Not authorized to view earnings for this content' });
        }

        const selectedMonth = req.query.month; // optional YYYY-MM
        const selectedDate = req.query.date;   // optional YYYY-MM-DD

        // ── PPV Revenue ──
        let ppvLifetime = { grossRevenue: 0, netEarnings: 0, totalPurchases: 0 };
        let ppvFiltered = { grossRevenue: 0, netEarnings: 0, totalPurchases: 0 };
        let ppvMonthlyChart = [];
        const isPpvContent = content.visibility === 'pay_per_view' || content.visibility === 'ppv' || Boolean(content.isPayPerView) || Boolean(content.price && content.price > 0);

        if (isPpvContent) {
            // Lifetime PPV
            const lifetimePpv = await Purchase.aggregate([
                { $match: { contentId: new mongoose.Types.ObjectId(contentId), status: { $in: ['active', 'expired'] } } },
                { $group: { _id: null, total: { $sum: 1 }, gross: { $sum: '$amount' }, net: { $sum: { $ifNull: ['$creatorPayout', { $multiply: ['$amount', 0.61308] }] } } } }
            ]);
            if (lifetimePpv[0]) {
                ppvLifetime = { grossRevenue: lifetimePpv[0].gross, netEarnings: lifetimePpv[0].net, totalPurchases: lifetimePpv[0].total };
            }

            // Monthly chart data (last 12 months)
            ppvMonthlyChart = await Purchase.aggregate([
                { $match: { contentId: new mongoose.Types.ObjectId(contentId), status: { $in: ['active', 'expired'] } } },
                { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$purchasedAt' } }, gross: { $sum: '$amount' }, net: { $sum: { $ifNull: ['$creatorPayout', { $multiply: ['$amount', 0.61308] }] } }, count: { $sum: 1 } } },
                { $sort: { _id: -1 } },
                { $limit: 12 },
                { $project: { month: '$_id', grossRevenue: '$gross', netEarnings: '$net', purchases: '$count', _id: 0 } }
            ]);

            // Filtered PPV (by month or date)
            if (selectedMonth || selectedDate) {
                let dateMatch = {};
                if (selectedDate) {
                    const start = new Date(`${selectedDate}T00:00:00.000+05:30`);
                    const end = new Date(`${selectedDate}T23:59:59.999+05:30`);
                    dateMatch = { purchasedAt: { $gte: start, $lte: end } };
                } else if (selectedMonth) {
                    const [y, m] = selectedMonth.split('-');
                    const start = new Date(Date.UTC(parseInt(y), parseInt(m) - 1, 1));
                    const end = new Date(Date.UTC(parseInt(y), parseInt(m), 1));
                    dateMatch = { purchasedAt: { $gte: start, $lt: end } };
                }
                const filteredPpv = await Purchase.aggregate([
                    { $match: { contentId: new mongoose.Types.ObjectId(contentId), status: { $in: ['active', 'expired'] }, ...dateMatch } },
                    { $group: { _id: null, total: { $sum: 1 }, gross: { $sum: '$amount' }, net: { $sum: { $ifNull: ['$creatorPayout', { $multiply: ['$amount', 0.61308] }] } } } }
                ]);
                if (filteredPpv[0]) {
                    ppvFiltered = { grossRevenue: filteredPpv[0].gross, netEarnings: filteredPpv[0].net, totalPurchases: filteredPpv[0].total };
                }
            }
        }

        // ── Engagement Earnings ──
        const wallet = await SecondaryWallet.findOne({ userId }).select('_id').lean();
        let engagementLifetime = { totalEarnings: 0, totalPayouts: 0 };
        let engagementFiltered = { totalEarnings: 0, totalPayouts: 0 };
        let engagementMonthlyChart = [];

        if (wallet) {
            // Lifetime engagement earnings for this content
            const lifetimeEng = await WalletTransaction.aggregate([
                { $match: { walletId: wallet._id, type: 'engagement_earning_credit', relatedContentId: new mongoose.Types.ObjectId(contentId), status: 'completed' } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]);
            if (lifetimeEng[0]) {
                engagementLifetime = { totalEarnings: lifetimeEng[0].total, totalPayouts: lifetimeEng[0].count };
            }

            // Monthly chart
            engagementMonthlyChart = await WalletTransaction.aggregate([
                { $match: { walletId: wallet._id, type: 'engagement_earning_credit', relatedContentId: new mongoose.Types.ObjectId(contentId), status: 'completed' } },
                { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
                { $sort: { _id: -1 } },
                { $limit: 12 },
                { $project: { month: '$_id', totalEarnings: '$total', payoutCount: '$count', _id: 0 } }
            ]);

            // Filtered engagement
            if (selectedMonth || selectedDate) {
                let dateMatch = {};
                if (selectedDate) {
                    const start = new Date(`${selectedDate}T00:00:00.000+05:30`);
                    const end = new Date(`${selectedDate}T23:59:59.999+05:30`);
                    dateMatch = { createdAt: { $gte: start, $lte: end } };
                } else if (selectedMonth) {
                    const [y, m] = selectedMonth.split('-');
                    const start = new Date(Date.UTC(parseInt(y), parseInt(m) - 1, 1));
                    const end = new Date(Date.UTC(parseInt(y), parseInt(m), 1));
                    dateMatch = { createdAt: { $gte: start, $lt: end } };
                }
                const filteredEng = await WalletTransaction.aggregate([
                    { $match: { walletId: wallet._id, type: 'engagement_earning_credit', relatedContentId: new mongoose.Types.ObjectId(contentId), status: 'completed', ...dateMatch } },
                    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
                ]);
                if (filteredEng[0]) {
                    engagementFiltered = { totalEarnings: filteredEng[0].total, totalPayouts: filteredEng[0].count };
                }
            }
        }

        // Available months
        const nowObj = new Date();
        const availableMonths = [];
        for (let i = 0; i < 12; i++) {
            const d = new Date(Date.UTC(nowObj.getUTCFullYear(), nowObj.getUTCMonth() - i, 1));
            availableMonths.push({
                value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
                label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
            });
        }

        res.json({
            contentId,
            contentTitle: content.title,
            contentType: content.contentType,
            isPpv: isPpvContent,
            ppv: {
                lifetime: ppvLifetime,
                filtered: ppvFiltered,
                monthlyChart: ppvMonthlyChart,
            },
            engagement: {
                lifetime: engagementLifetime,
                filtered: engagementFiltered,
                monthlyChart: engagementMonthlyChart,
            },
            availableMonths,
        });
    } catch (error) {
        console.error('❌ Error fetching content earnings:', error);
        res.status(500).json({ error: 'Failed to fetch content earnings' });
    }
};
