/**
 * Payout Job Controller
 *
 * - runMonthEndPayout: Processes all secondary wallets with balance > 0
 *   Idempotent — safe to run multiple times per month
 * - getPayoutReport: Admin view of payouts for a given month
 *
 * REFACTORED: Uses SecondaryWallet + KycDetails (separate models)
 */
import mongoose from 'mongoose';
import SecondaryWallet from '../../models/secondaryWallet.model.js';
import PrimaryWallet from '../../models/primaryWallet.model.js';
import KycDetails from '../../models/kycDetails.model.js';
import WalletTransaction from '../../models/walletTransaction.model.js';
import Payout from '../../models/payout.model.js';
import Purchase from '../../models/purchase.model.js';
import User from '../../models/user.model.js';
import { decryptBankDetails } from '../../utils/encryption.js';
import { sendAdminEmail } from '../../services/adminEmailService.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const MAINTENANCE_FEE_PERCENT = 0; // 0% — no payout fee

/**
 * POST /admin/payouts/run — Run month-end payout job
 * Finds all secondary wallets with balance > 0, paired with submitted KYC
 * Processes each in an individual atomic transaction
 */
export const runMonthEndPayout = async (req, res) => {
    try {
        const now = new Date();
        const payoutMonth = req.body.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        // Find all secondary wallets with balance > 0
        const wallets = await SecondaryWallet.find({ balance: { $gt: 0 } }).lean();

        // Get KYC details for all wallet owners
        const userIds = wallets.map(w => w.userId);
        const kycDocs = await KycDetails.find({
            userId: { $in: userIds },
            kycStatus: { $in: ['submitted', 'pending', 'verified'] },
        }).lean();
        const kycByUser = new Map(kycDocs.map(k => [k.userId.toString(), k]));

        const results = { processed: 0, skipped: 0, failed: 0, skippedNoKyc: 0, errors: [] };

        for (const wallet of wallets) {
            const kyc = kycByUser.get(wallet.userId.toString());
            
            // Skip processing payout if KYC is missing, not submitted, or rejected
            if (!kyc || kyc.kycStatus === 'rejected') {
                results.skippedNoKyc++;
                results.skipped++;
                console.log(`⏩ Skipping payout for wallet ${wallet._id} (User ${wallet.userId}): KYC missing or rejected`);
                continue;
            }

            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async () => {
                    // Idempotency check
                    const existingPayout = await Payout.findOne({
                        walletId: wallet._id,
                        payoutMonth,
                    }).session(session);
                    if (existingPayout) {
                        results.skipped++;
                        return;
                    }

                    // Re-read wallet inside session to get latest balance
                    const freshWallet = await SecondaryWallet.findById(wallet._id).session(session);
                    if (!freshWallet || freshWallet.balance <= 0) {
                        results.skipped++;
                        return;
                    }

                    const grossAmount = freshWallet.balance;
                    const feeAmount = Math.round(grossAmount * MAINTENANCE_FEE_PERCENT * 100) / 100;
                    const netAmount = Math.round((grossAmount - feeAmount) * 100) / 100;

                    // Zero out the wallet balance atomically
                    await SecondaryWallet.findOneAndUpdate(
                        { _id: freshWallet._id },
                        { $set: { balance: 0 } },
                        { session }
                    );

                    // Write payout ledger entry
                    const idempotencyKey = `payout_${wallet._id}_${payoutMonth}`;
                    await WalletTransaction.create([{
                        walletId: freshWallet._id,
                        walletType: 'secondary',
                        type: 'payout',
                        amount: grossAmount,
                        balanceAfter: 0,
                        status: 'completed',
                        idempotencyKey,
                    }], { session });

                    // Snapshot encrypted bank details from KYC for the payout record
                    const bankSnapshot = {};
                    const bankFields = [
                        'bankAccountNumberEncrypted', 'bankAccountIv', 'bankAccountTag',
                        'ifscCodeEncrypted', 'ifscCodeIv', 'ifscCodeTag',
                        'accountHolderNameEncrypted', 'accountHolderNameIv', 'accountHolderNameTag',
                    ];
                    bankFields.forEach(f => { bankSnapshot[f] = kyc[f]; });

                    // Decrypt bank name for the payout record (plain text field)
                    const bankName = decryptBankDetails(kyc).bankName || '';

                    // Calculate tax aggregates from creator's earning transactions
                    const earningTxns = await WalletTransaction.find({
                        walletId: freshWallet._id,
                        type: 'ppv_earning_credit',
                        status: 'completed',
                    }).session(session).lean();

                    let totalSellingPrice = 0, totalBasePrice = 0, totalGstCollected = 0;
                    let totalPlatformCommission = 0, totalGstOnCommission = 0;
                    let totalTdsDeducted = 0, totalTcsDeducted = 0;

                    for (const tx of earningTxns) {
                        if (tx.taxBreakdown) {
                            totalSellingPrice += tx.taxBreakdown.sellingPrice || 0;
                            totalBasePrice += tx.taxBreakdown.basePrice || 0;
                            totalGstCollected += tx.taxBreakdown.gstAmount || 0;
                            totalPlatformCommission += tx.taxBreakdown.platformCommission || 0;
                            totalGstOnCommission += tx.taxBreakdown.gstOnCommission || 0;
                            totalTdsDeducted += tx.taxBreakdown.tdsAmount || 0;
                            totalTcsDeducted += tx.taxBreakdown.tcsAmount || 0;
                        }
                    }

                    await Payout.create([{
                        walletId: freshWallet._id,
                        userId: freshWallet.userId,
                        grossAmount,
                        feeAmount,
                        netAmount,
                        totalSellingPrice: Number(totalSellingPrice.toFixed(2)),
                        totalBasePrice: Number(totalBasePrice.toFixed(2)),
                        totalGstCollected: Number(totalGstCollected.toFixed(2)),
                        totalPlatformCommission: Number(totalPlatformCommission.toFixed(2)),
                        totalGstOnCommission: Number(totalGstOnCommission.toFixed(2)),
                        totalTdsDeducted: Number(totalTdsDeducted.toFixed(2)),
                        totalTcsDeducted: Number(totalTcsDeducted.toFixed(2)),
                        ...bankSnapshot,
                        bankName: bankName,
                        status: 'pending_settlement',
                        payoutMonth,
                        scheduledFor: new Date(),
                    }], { session });

                    results.processed++;

                    // Send email notification to creator
                    const user = await User.findById(freshWallet.userId).select('email userName channelName').lean();
                    if (user?.email) {
                        sendAdminEmail('payoutInitiated', user.email, {
                            creatorName: user.channelName || user.userName || 'Creator',
                            netAmount,
                            grossAmount,
                            payoutMonth
                        }).catch(e => console.error('Payout email error:', e));
                    }
                });
            } catch (err) {
                results.failed++;
                results.errors.push({ walletId: wallet._id.toString(), error: err.message });
                console.error(`❌ Payout failed for wallet ${wallet._id}:`, err);
            } finally {
                await session.endSession();
            }
        }

        console.log(`✅ Payout job completed for ${payoutMonth}:`, results);
        res.json({
            success: true,
            payoutMonth,
            totalWallets: wallets.length,
            ...results,
        });
    } catch (error) {
        console.error('❌ Payout job error:', error);
        res.status(500).json({ error: 'Payout job failed' });
    }
};

/**
 * GET /admin/payouts/:month — Get payout report for a month
 * Returns all payouts with decrypted bank details and KYC document presigned URL
 */
export const getPayoutReport = async (req, res) => {
    try {
        const { month } = req.params;

        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ error: 'Month must be in YYYY-MM format' });
        }

        const payouts = await Payout.find({ payoutMonth: month })
            .populate('userId', 'userName channelName contact')
            .sort({ createdAt: -1 })
            .lean();

        // For each payout, decrypt bank details and generate document presigned URL
        const enrichedPayouts = await Promise.all(payouts.map(async (payout) => {
            const bankDetails = decryptBankDetails(payout);

            // Get KYC document presigned URL from KycDetails
            let kycDocumentUrl = null;
            let kycDocumentType = null;
            const kyc = await KycDetails.findOne({ userId: payout.userId?._id || payout.userId })
                .select('kycDocumentKey kycDocumentType').lean();
            if (kyc?.kycDocumentKey) {
                kycDocumentType = kyc.kycDocumentType;
                try {
                    const command = new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: kyc.kycDocumentKey,
                    });
                    kycDocumentUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 }); // 15 min
                } catch (err) {
                    console.error(`Failed to generate presigned URL for ${kyc.kycDocumentKey}:`, err);
                }
            }

            return {
                _id: payout._id,
                userId: payout.userId?._id,
                userName: payout.userId?.channelName || payout.userId?.userName,
                contact: payout.userId?.contact,
                grossAmount: payout.grossAmount,
                feeAmount: payout.feeAmount,
                netAmount: payout.netAmount,
                totalSellingPrice: payout.totalSellingPrice || 0,
                totalBasePrice: payout.totalBasePrice || 0,
                totalGstCollected: payout.totalGstCollected || 0,
                totalPlatformCommission: payout.totalPlatformCommission || 0,
                totalGstOnCommission: payout.totalGstOnCommission || 0,
                totalTdsDeducted: payout.totalTdsDeducted || 0,
                totalTcsDeducted: payout.totalTcsDeducted || 0,
                bankDetails: {
                    accountNumber: bankDetails.bankAccountNumber,
                    bankName: payout.bankName || bankDetails.bankName,
                    ifscCode: bankDetails.ifscCode,
                    accountHolderName: bankDetails.accountHolderName,
                },
                kycDocument: {
                    type: kycDocumentType,
                    url: kycDocumentUrl,
                },
                status: payout.status,
                scheduledFor: payout.scheduledFor,
                processedAt: payout.processedAt,
                createdAt: payout.createdAt,
            };
        }));

        const totalGross = payouts.reduce((sum, p) => sum + p.grossAmount, 0);
        const totalFees = payouts.reduce((sum, p) => sum + p.feeAmount, 0);
        const totalNet = payouts.reduce((sum, p) => sum + p.netAmount, 0);
        const totalSellingPrice = payouts.reduce((sum, p) => sum + (p.totalSellingPrice || 0), 0);
        const totalBasePrice = payouts.reduce((sum, p) => sum + (p.totalBasePrice || 0), 0);
        const totalGstCollected = payouts.reduce((sum, p) => sum + (p.totalGstCollected || 0), 0);
        const totalPlatformCommission = payouts.reduce((sum, p) => sum + (p.totalPlatformCommission || 0), 0);
        const totalGstOnCommission = payouts.reduce((sum, p) => sum + (p.totalGstOnCommission || 0), 0);
        const totalTdsDeducted = payouts.reduce((sum, p) => sum + (p.totalTdsDeducted || 0), 0);
        const totalTcsDeducted = payouts.reduce((sum, p) => sum + (p.totalTcsDeducted || 0), 0);

        res.json({
            payoutMonth: month,
            summary: {
                totalPayouts: payouts.length,
                totalGross: Math.round(totalGross * 100) / 100,
                totalFees: Math.round(totalFees * 100) / 100,
                totalNet: Math.round(totalNet * 100) / 100,
                totalSellingPrice: Math.round(totalSellingPrice * 100) / 100,
                totalBasePrice: Math.round(totalBasePrice * 100) / 100,
                totalGstCollected: Math.round(totalGstCollected * 100) / 100,
                totalPlatformCommission: Math.round(totalPlatformCommission * 100) / 100,
                totalGstOnCommission: Math.round(totalGstOnCommission * 100) / 100,
                totalTdsDeducted: Math.round(totalTdsDeducted * 100) / 100,
                totalTcsDeducted: Math.round(totalTcsDeducted * 100) / 100,
            },
            payouts: enrichedPayouts,
        });
    } catch (error) {
        console.error('❌ Error fetching payout report:', error);
        res.status(500).json({ error: 'Failed to fetch payout report' });
    }
};

/**
 * POST /admin/payouts/run-single — SuperAdmin manual payout for a single creator
 */
export const runSingleCreatorPayout = async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: "userId is required" });
        }

        const wallet = await SecondaryWallet.findOne({ userId });
        if (!wallet || wallet.balance <= 0) {
            return res.status(400).json({ error: "Creator has no withdrawable secondary wallet balance" });
        }

        const kyc = await KycDetails.findOne({ userId });
        if (!kyc || kyc.kycStatus === 'rejected') {
            return res.status(400).json({ error: "Creator KYC missing or rejected" });
        }

        const now = new Date();
        const payoutMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}_MANUAL_${Date.now()}`;

        const session = await mongoose.startSession();
        let createdPayout;
        try {
            await session.withTransaction(async () => {
                const freshWallet = await SecondaryWallet.findById(wallet._id).session(session);
                if (!freshWallet || freshWallet.balance <= 0) {
                    throw new Error("Wallet balance is zero");
                }

                const grossAmount = freshWallet.balance;
                const feeAmount = Math.round(grossAmount * MAINTENANCE_FEE_PERCENT * 100) / 100;
                const netAmount = Math.round((grossAmount - feeAmount) * 100) / 100;

                await SecondaryWallet.findOneAndUpdate(
                    { _id: freshWallet._id },
                    { $set: { balance: 0 } },
                    { session }
                );

                const idempotencyKey = `payout_${wallet._id}_${payoutMonth}`;
                await WalletTransaction.create([{
                    walletId: freshWallet._id,
                    walletType: 'secondary',
                    type: 'payout',
                    amount: grossAmount,
                    balanceAfter: 0,
                    status: 'completed',
                    idempotencyKey,
                }], { session });

                const bankSnapshot = {};
                const bankFields = [
                    'bankAccountNumberEncrypted', 'bankAccountIv', 'bankAccountTag',
                    'ifscCodeEncrypted', 'ifscCodeIv', 'ifscCodeTag',
                    'accountHolderNameEncrypted', 'accountHolderNameIv', 'accountHolderNameTag',
                ];
                bankFields.forEach(f => { bankSnapshot[f] = kyc[f]; });
                const bankName = decryptBankDetails(kyc).bankName || '';

                const earningTxns = await WalletTransaction.find({
                    walletId: freshWallet._id,
                    type: 'ppv_earning_credit',
                    status: 'completed',
                }).session(session).lean();

                let totalSellingPrice = 0, totalBasePrice = 0, totalGstCollected = 0;
                let totalPlatformCommission = 0, totalGstOnCommission = 0;
                let totalTdsDeducted = 0, totalTcsDeducted = 0;

                for (const tx of earningTxns) {
                    if (tx.taxBreakdown) {
                        totalSellingPrice += tx.taxBreakdown.sellingPrice || 0;
                        totalBasePrice += tx.taxBreakdown.basePrice || 0;
                        totalGstCollected += tx.taxBreakdown.gstAmount || 0;
                        totalPlatformCommission += tx.taxBreakdown.platformCommission || 0;
                        totalGstOnCommission += tx.taxBreakdown.gstOnCommission || 0;
                        totalTdsDeducted += tx.taxBreakdown.tdsAmount || 0;
                        totalTcsDeducted += tx.taxBreakdown.tcsAmount || 0;
                    }
                }

                [createdPayout] = await Payout.create([{
                    walletId: freshWallet._id,
                    userId: freshWallet.userId,
                    grossAmount,
                    feeAmount,
                    netAmount,
                    totalSellingPrice: Number(totalSellingPrice.toFixed(2)),
                    totalBasePrice: Number(totalBasePrice.toFixed(2)),
                    totalGstCollected: Number(totalGstCollected.toFixed(2)),
                    totalPlatformCommission: Number(totalPlatformCommission.toFixed(2)),
                    totalGstOnCommission: Number(totalGstOnCommission.toFixed(2)),
                    totalTdsDeducted: Number(totalTdsDeducted.toFixed(2)),
                    totalTcsDeducted: Number(totalTcsDeducted.toFixed(2)),
                    ...bankSnapshot,
                    bankName: bankName,
                    status: 'pending_settlement',
                    payoutMonth,
                    scheduledFor: new Date(),
                }], { session });
            });

            // Send notification email to creator
            const user = await User.findById(userId).select('email userName channelName').lean();
            if (user?.email) {
                sendAdminEmail('payoutInitiated', user.email, {
                    creatorName: user.channelName || user.userName || 'Creator',
                    netAmount: createdPayout.netAmount,
                    grossAmount: createdPayout.grossAmount,
                    payoutMonth
                }).catch(e => console.error('Single payout email error:', e));
            }

            res.json({
                success: true,
                message: "Single creator payout executed successfully",
                payout: createdPayout
            });
        } finally {
            await session.endSession();
        }
    } catch (error) {
        console.error('❌ Error executing single creator payout:', error);
        res.status(500).json({ error: error.message || 'Failed to execute payout' });
    }
};

/**
 * GET /admin/payouts/daily-stats — Get daily payout stats
 */
export const getDailyPayoutStats = async (req, res) => {
    try {
        let dateStr = req.query.date;
        if (!dateStr) {
            // Get today in IST YYYY-MM-DD
            const now = new Date();
            const istOffset = 5.5 * 60 * 60 * 1000;
            const istTime = new Date(now.getTime() + istOffset);
            dateStr = istTime.toISOString().split('T')[0];
        }

        const startOfDay = new Date(`${dateStr}T00:00:00.000+05:30`);
        const endOfDay = new Date(`${dateStr}T23:59:59.999+05:30`);

        const wTx = await WalletTransaction.aggregate([
            {
                $match: {
                    createdAt: { $gte: startOfDay, $lte: endOfDay },
                    status: 'completed',
                    type: { $in: ['recharge', 'transfer_to_primary', 'ppv_purchase_debit'] }
                }
            },
            {
                $group: {
                    _id: '$type',
                    total: { $sum: '$amount' }
                }
            }
        ]);

        let totalCreditedToW1 = 0;
        let secondaryToPrimary = 0;
        let walletPPV = 0;

        wTx.forEach(t => {
            if (t._id === 'recharge') totalCreditedToW1 = t.total;
            if (t._id === 'transfer_to_primary') secondaryToPrimary = t.total;
            if (t._id === 'ppv_purchase_debit') walletPPV = t.total;
        });

        const purchases = await Purchase.aggregate([
            {
                $match: {
                    purchasedAt: { $gte: startOfDay, $lte: endOfDay },
                    status: { $in: ['active', 'expired'] }
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: '$amount' }
                }
            }
        ]);
        const gatewayPPV = purchases.length > 0 ? purchases[0].total : 0;

        const w1 = await PrimaryWallet.aggregate([{ $group: { _id: null, total: { $sum: '$balance' } } }]);
        const totalW1Balance = w1.length > 0 ? w1[0].total : 0;

        const w2 = await SecondaryWallet.aggregate([{ $group: { _id: null, total: { $sum: '$balance' } } }]);
        const totalW2Balance = w2.length > 0 ? w2[0].total : 0;

        return res.json({
            date: dateStr,
            totalCreditedToW1,
            secondaryToPrimary,
            walletPPV,
            gatewayPPV,
            totalW1Balance,
            totalW2Balance
        });
    } catch (error) {
        console.error('❌ Error getting daily payout stats:', error);
        return res.status(500).json({ error: 'Failed to fetch daily payout stats' });
    }
};
