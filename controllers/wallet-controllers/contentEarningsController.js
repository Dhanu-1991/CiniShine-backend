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
import EngagementPayout from '../../models/engagementPayout.model.js';

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

        const contentObjId = new mongoose.Types.ObjectId(contentId);
        const contentStrId = contentId.toString();

        let lifetimeTotal = 0;
        let lifetimeCount = 0;
        let filteredTotal = 0;
        let filteredCount = 0;
        const monthlyMap = new Map();

        // 1. Query EngagementPayout records (strongly typed contentPayouts array)
        const engPayouts = await EngagementPayout.find({
            status: { $in: ['completed', 'partial'] },
            $or: [
                { 'contentPayouts.contentId': contentObjId },
                { 'contentPayouts.contentId': contentStrId }
            ]
        }).sort({ createdAt: -1 }).lean();

        for (const ep of engPayouts) {
            const item = (ep.contentPayouts || []).find(
                c => c.contentId?.toString() === contentStrId
            );
            if (item && item.payoutAmount > 0) {
                const amount = Number(item.payoutAmount || 0);
                lifetimeTotal += amount;
                lifetimeCount += 1;

                const epDateObj = new Date(ep.createdAt);
                const mKey = `${epDateObj.getUTCFullYear()}-${String(epDateObj.getUTCMonth() + 1).padStart(2, '0')}`;
                monthlyMap.set(mKey, (monthlyMap.get(mKey) || 0) + amount);

                let isFilteredMatch = false;
                if (selectedDate) {
                    const start = new Date(`${selectedDate}T00:00:00.000+05:30`);
                    const end = new Date(`${selectedDate}T23:59:59.999+05:30`);
                    if (epDateObj >= start && epDateObj <= end) isFilteredMatch = true;
                } else if (selectedMonth) {
                    if (mKey === selectedMonth) isFilteredMatch = true;
                }

                if (isFilteredMatch) {
                    filteredTotal += amount;
                    filteredCount += 1;
                }
            }
        }

        // 2. Query WalletTransaction records for any additional direct or aggregated transactions
        if (wallet) {
            const engTxns = await WalletTransaction.find({
                walletId: wallet._id,
                type: 'engagement_earning_credit',
                status: 'completed'
            }).sort({ createdAt: -1 }).lean();

            for (const txn of engTxns) {
                let earnedForThisContent = 0;
                if (txn.metadata?.contentBreakdown && Array.isArray(txn.metadata.contentBreakdown)) {
                    const item = txn.metadata.contentBreakdown.find(
                        c => c.contentId?.toString() === contentStrId
                    );
                    if (item) earnedForThisContent = Number(item.payoutAmount || 0);
                } else if (txn.relatedContentId?.toString() === contentStrId) {
                    earnedForThisContent = Number(txn.amount || 0);
                }

                // If this transaction is NOT already accounted for in lifetimeTotal from EngagementPayout
                if (earnedForThisContent > 0 && engPayouts.length === 0) {
                    lifetimeTotal += earnedForThisContent;
                    lifetimeCount += 1;

                    const txnDateObj = new Date(txn.createdAt);
                    const mKey = `${txnDateObj.getUTCFullYear()}-${String(txnDateObj.getUTCMonth() + 1).padStart(2, '0')}`;
                    monthlyMap.set(mKey, (monthlyMap.get(mKey) || 0) + earnedForThisContent);

                    let isFilteredMatch = false;
                    if (selectedDate) {
                        const start = new Date(`${selectedDate}T00:00:00.000+05:30`);
                        const end = new Date(`${selectedDate}T23:59:59.999+05:30`);
                        if (txnDateObj >= start && txnDateObj <= end) isFilteredMatch = true;
                    } else if (selectedMonth) {
                        if (mKey === selectedMonth) isFilteredMatch = true;
                    }

                    if (isFilteredMatch) {
                        filteredTotal += earnedForThisContent;
                        filteredCount += 1;
                    }
                }
            }
        }

        engagementLifetime = { totalEarnings: parseFloat(lifetimeTotal.toFixed(2)), totalPayouts: lifetimeCount };
        engagementFiltered = { totalEarnings: parseFloat(filteredTotal.toFixed(2)), totalPayouts: filteredCount };

        engagementMonthlyChart = Array.from(monthlyMap.entries()).map(([month, totalEarnings]) => ({
            month,
            totalEarnings: parseFloat(totalEarnings.toFixed(2)),
            payoutCount: 1
        })).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12);

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
