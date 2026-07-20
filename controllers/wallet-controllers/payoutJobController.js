/**
 * Payout Job Controller
 *
 * - runMonthEndPayout: Processes all settlement wallets with balance > 0
 *   Idempotent — safe to run multiple times per month
 * - getPayoutReport: Admin view of payouts for a given month
 */
import mongoose from 'mongoose';
import Wallet from '../../models/wallet.model.js';
import WalletTransaction from '../../models/walletTransaction.model.js';
import Payout from '../../models/payout.model.js';
import { decryptBankDetails, encryptBankDetails } from '../../utils/encryption.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const MAINTENANCE_FEE_PERCENT = 0.01; // 1%

/**
 * POST /admin/payouts/run — Run month-end payout job
 * Finds all settlement wallets with kycStatus=submitted and balance > 0
 * Processes each in an individual atomic transaction
 */
export const runMonthEndPayout = async (req, res) => {
    try {
        // Determine payout month (default: current month, or override via query)
        const now = new Date();
        const payoutMonth = req.body.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        // Find all settlement wallets with balance > 0 and completed KYC
        const wallets = await Wallet.find({
            type: 'settlement',
            kycStatus: 'submitted',
            balance: { $gt: 0 },
        }).lean();

        const results = { processed: 0, skipped: 0, failed: 0, errors: [] };

        for (const wallet of wallets) {
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async () => {
                    // Idempotency check: skip if payout already exists for this wallet + month
                    const existingPayout = await Payout.findOne({
                        walletId: wallet._id,
                        payoutMonth,
                    }).session(session);
                    if (existingPayout) {
                        results.skipped++;
                        return;
                    }

                    // Re-read wallet inside session to get latest balance
                    const freshWallet = await Wallet.findById(wallet._id).session(session);
                    if (!freshWallet || freshWallet.balance <= 0) {
                        results.skipped++;
                        return;
                    }

                    const grossAmount = freshWallet.balance;
                    const feeAmount = Math.round(grossAmount * MAINTENANCE_FEE_PERCENT * 100) / 100;
                    const netAmount = Math.round((grossAmount - feeAmount) * 100) / 100;

                    // Zero out the wallet balance atomically
                    await Wallet.findOneAndUpdate(
                        { _id: freshWallet._id },
                        { $set: { balance: 0 } },
                        { session }
                    );

                    // Write payout ledger entry
                    const idempotencyKey = `payout_${wallet._id}_${payoutMonth}`;
                    await WalletTransaction.create([{
                        walletId: freshWallet._id,
                        type: 'payout',
                        amount: grossAmount,
                        balanceAfter: 0,
                        status: 'completed',
                        idempotencyKey,
                    }], { session });

                    // Snapshot encrypted bank details for the payout record
                    const bankSnapshot = {};
                    const bankFields = [
                        'bankAccountNumberEncrypted', 'bankAccountIv', 'bankAccountTag',
                        'ifscCodeEncrypted', 'ifscCodeIv', 'ifscCodeTag',
                        'accountHolderNameEncrypted', 'accountHolderNameIv', 'accountHolderNameTag',
                    ];
                    bankFields.forEach(f => { bankSnapshot[f] = freshWallet[f]; });

                    // Decrypt bank name for the payout record (plain text field)
                    const decrypted = decryptBankDetails(freshWallet);

                    await Payout.create([{
                        walletId: freshWallet._id,
                        userId: freshWallet.userId,
                        grossAmount,
                        feeAmount,
                        netAmount,
                        ...bankSnapshot,
                        bankName: decrypted.bankName || '',
                        status: 'pending_settlement',
                        payoutMonth,
                        scheduledFor: new Date(),
                    }], { session });

                    results.processed++;
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
        const { month } = req.params; // '2026-07' format

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

            // Get KYC document presigned URL from the wallet
            let kycDocumentUrl = null;
            const wallet = await Wallet.findById(payout.walletId).select('kycDocumentKey kycDocumentType').lean();
            if (wallet?.kycDocumentKey) {
                try {
                    const command = new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET, // Using main bucket until private KYC bucket is set up
                        Key: wallet.kycDocumentKey,
                    });
                    kycDocumentUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 }); // 15 min
                } catch (err) {
                    console.error(`Failed to generate presigned URL for ${wallet.kycDocumentKey}:`, err);
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
                bankDetails: {
                    accountNumber: bankDetails.bankAccountNumber,
                    bankName: payout.bankName || bankDetails.bankName,
                    ifscCode: bankDetails.ifscCode,
                    accountHolderName: bankDetails.accountHolderName,
                },
                kycDocument: {
                    type: wallet?.kycDocumentType,
                    url: kycDocumentUrl,
                },
                status: payout.status,
                scheduledFor: payout.scheduledFor,
                processedAt: payout.processedAt,
                createdAt: payout.createdAt,
            };
        }));

        // Summary totals
        const totalGross = payouts.reduce((sum, p) => sum + p.grossAmount, 0);
        const totalFees = payouts.reduce((sum, p) => sum + p.feeAmount, 0);
        const totalNet = payouts.reduce((sum, p) => sum + p.netAmount, 0);

        res.json({
            payoutMonth: month,
            summary: {
                totalPayouts: payouts.length,
                totalGross: Math.round(totalGross * 100) / 100,
                totalFees: Math.round(totalFees * 100) / 100,
                totalNet: Math.round(totalNet * 100) / 100,
            },
            payouts: enrichedPayouts,
        });
    } catch (error) {
        console.error('❌ Error fetching payout report:', error);
        res.status(500).json({ error: 'Failed to fetch payout report' });
    }
};
