import mongoose from 'mongoose';
import WalletTransaction from '../../models/walletTransaction.model.js';
import Purchase from '../../models/purchase.model.js';

/**
 * GET /admin/ledger/daily
 * Aggregates platform financial data by day.
 */
export const getDailyLedger = async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(days));

        // Aggregate Wallet Transactions
        const walletAgg = await WalletTransaction.aggregate([
            {
                $match: {
                    status: 'completed',
                    createdAt: { $gte: startDate }
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
                    totalRecharge: {
                        $sum: { $cond: [{ $eq: ["$type", "recharge"] }, "$amount", 0] }
                    },
                    walletPPVSales: {
                        $sum: { $cond: [{ $eq: ["$type", "ppv_purchase_debit"] }, "$amount", 0] }
                    },
                    walletToWalletTransfers: {
                        $sum: { $cond: [{ $eq: ["$type", "transfer_to_primary"] }, "$amount", 0] }
                    },
                    payoutFees: {
                        $sum: { $cond: [{ $eq: ["$type", "payout_fee"] }, "$amount", 0] }
                    },
                    payouts: {
                        $sum: { $cond: [{ $eq: ["$type", "payout"] }, "$amount", 0] }
                    }
                }
            }
        ]);

        // Aggregate Direct Purchases (Gateway PPV)
        const purchaseAgg = await Purchase.aggregate([
            {
                $match: {
                    status: { $in: ['active', 'expired'] },
                    purchasedAt: { $gte: startDate }
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$purchasedAt", timezone: "Asia/Kolkata" } },
                    gatewayPPVSales: { $sum: "$amount" }
                }
            }
        ]);

        // Merge the two aggregations
        const merged = {};

        walletAgg.forEach(item => {
            merged[item._id] = {
                date: item._id,
                totalRecharge: item.totalRecharge || 0,
                walletPPVSales: item.walletPPVSales || 0,
                gatewayPPVSales: 0,
                walletToWalletTransfers: item.walletToWalletTransfers || 0,
                payoutFees: item.payoutFees || 0,
                payouts: item.payouts || 0,
                platformRevenue: (item.walletPPVSales * 0.3) + (item.payoutFees || 0)
            };
        });

        purchaseAgg.forEach(item => {
            if (!merged[item._id]) {
                merged[item._id] = {
                    date: item._id,
                    totalRecharge: 0,
                    walletPPVSales: 0,
                    gatewayPPVSales: 0,
                    walletToWalletTransfers: 0,
                    payoutFees: 0,
                    payouts: 0,
                    platformRevenue: 0
                };
            }
            // Some purchases are wallet based, so we need to deduplicate them.
            // But we don't know which is which in Purchase if it lacks paymentMethod.
            // Assuming gatewayPPVSales is all purchases minus walletPPVSales
            merged[item._id].gatewayPPVSales = Math.max(0, item.gatewayPPVSales - merged[item._id].walletPPVSales);
            
            // Adjust revenue to include gateway sales cut
            merged[item._id].platformRevenue += (merged[item._id].gatewayPPVSales * 0.3);
        });

        // Sort by date ascending
        const ledger = Object.values(merged).sort((a, b) => a.date.localeCompare(b.date));

        res.json({ success: true, ledger });
    } catch (error) {
        console.error("Ledger error:", error);
        res.status(500).json({ error: "Failed to fetch ledger" });
    }
};

/**
 * GET /admin/ledger/live
 * Fetches recent live transfers (Wallet Transactions) with pagination and filters.
 */
export const getLiveTransfers = async (req, res) => {
    try {
        const { page = 1, limit = 20, type, search } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const filter = {};
        if (type && type !== 'all') {
            filter.type = type;
        }

        let pipeline = [
            { $match: filter },
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) },
            {
                $lookup: {
                    from: 'users', localField: 'relatedBuyerId', foreignField: '_id', as: 'buyer'
                }
            },
            { $unwind: { path: '$buyer', preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: 'primarywallets', localField: 'walletId', foreignField: '_id', as: 'pwallet'
                }
            },
            {
                $lookup: {
                    from: 'secondarywallets', localField: 'walletId', foreignField: '_id', as: 'swallet'
                }
            },
            {
                $addFields: {
                    wallet: {
                        $cond: {
                            if: { $gt: [{ $size: '$pwallet' }, 0] },
                            then: { $arrayElemAt: ['$pwallet', 0] },
                            else: { $arrayElemAt: ['$swallet', 0] }
                        }
                    }
                }
            },
            {
                $lookup: {
                    from: 'users', localField: 'wallet.userId', foreignField: '_id', as: 'walletUser'
                }
            },
            { $unwind: { path: '$walletUser', preserveNullAndEmptyArrays: true } }
        ];

        if (search) {
            pipeline.push({
                $match: {
                    $or: [
                        { 'walletUser.userName': new RegExp(search, 'i') },
                        { 'buyer.userName': new RegExp(search, 'i') },
                        { relatedOrderId: new RegExp(search, 'i') }
                    ]
                }
            });
        }

        const transactions = await WalletTransaction.aggregate(pipeline);
        
        // Compute total without search filter (since it's complex to count aggregate with search)
        // If search is present, total is just transactions.length for simplicity on admin panel
        const total = search ? transactions.length : await WalletTransaction.countDocuments(filter);

        res.json({
            success: true,
            transactions: transactions.map(t => ({
                _id: t._id,
                walletType: t.walletType,
                type: t.type,
                amount: t.amount,
                balanceAfter: t.balanceAfter,
                status: t.status,
                createdAt: t.createdAt,
                orderId: t.relatedOrderId,
                walletUser: t.walletUser ? {
                    id: t.walletUser._id?.toString(),
                    name: t.walletUser.userName,
                    contact: t.walletUser.contact
                } : null,
                walletUserId: t.walletUser?._id?.toString() || null,
                buyer: t.buyer ? {
                    id: t.buyer._id?.toString(),
                    name: t.buyer.userName,
                    contact: t.buyer.contact
                } : null,
                buyerId: t.buyer?._id?.toString() || null,
            })),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error("Live transfers error:", error);
        res.status(500).json({ error: "Failed to fetch live transfers" });
    }
};
