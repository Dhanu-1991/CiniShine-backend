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
import { calculateTaxBreakdown } from '../../utils/taxCalculator.js';
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

        console.log(`\n=================== [PAYOUT_JOB_BULK_INIT] ===================`);
        console.log(`Month: ${payoutMonth}`);

        // Find all secondary wallets with balance > 0
        const wallets = await SecondaryWallet.find({ balance: { $gt: 0 } }).lean();
        console.log(`Found ${wallets.length} secondary wallet(s) with balance > 0`);

        // Get KYC details for all wallet owners (MUST be verified)
        const userIds = wallets.map(w => w.userId);
        const kycDocs = await KycDetails.find({
            userId: { $in: userIds },
            kycStatus: 'verified',
        }).lean();
        const kycByUser = new Map(kycDocs.map(k => [k.userId.toString(), k]));

        const results = { processed: 0, skipped: 0, failed: 0, skippedNoKyc: 0, errors: [] };

        for (const wallet of wallets) {
            const kyc = kycByUser.get(wallet.userId.toString());
            
            // Skip processing payout if KYC is missing, pending, or not verified
            if (!kyc || kyc.kycStatus !== 'verified') {
                results.skippedNoKyc++;
                results.skipped++;
                console.log(`⏩ [PAYOUT_BULK_SKIP] Wallet ${wallet._id} (User ${wallet.userId}): KYC is not verified`);
                continue;
            }

            const session = await mongoose.startSession();
            try {
                let createdPayout;
                await session.withTransaction(async () => {
                    // Idempotency check
                    const existingPayout = await Payout.findOne({
                        walletId: wallet._id,
                        payoutMonth,
                    }).session(session);
                    if (existingPayout) {
                        results.skipped++;
                        console.log(`⏩ [PAYOUT_BULK_SKIP] Wallet ${wallet._id}: Payout for ${payoutMonth} already exists.`);
                        return;
                    }

                    // Guard: Skip if creator has a previous settlement pending
                    const pendingSettlement = await Payout.findOne({
                        walletId: wallet._id,
                        status: 'pending_settlement',
                    }).session(session);
                    if (pendingSettlement) {
                        results.skipped++;
                        console.log(`⏩ [PAYOUT_BULK_SKIP] Wallet ${wallet._id}: previous settlement (${pendingSettlement._id}) is still pending`);
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

                    // Calculate tax aggregates from creator's earning transactions since last payout
                    const lastPayoutDoc = await Payout.findOne({
                        walletId: freshWallet._id,
                        status: { $in: ['pending_settlement', 'completed'] },
                    }).sort({ createdAt: -1 }).session(session).lean();

                    const txnQuery = {
                        walletId: freshWallet._id,
                        type: 'ppv_earning_credit',
                        status: 'completed',
                    };
                    if (lastPayoutDoc && lastPayoutDoc.createdAt) {
                        txnQuery.createdAt = { $gt: lastPayoutDoc.createdAt };
                    }

                    const earningTxns = await WalletTransaction.find(txnQuery).session(session).lean();

                    let rawSelling = 0, rawBase = 0, rawGst = 0, rawComm = 0, rawCommGst = 0, rawTds = 0, rawTcs = 0, rawNet = 0;

                    for (const tx of earningTxns) {
                        let taxSource = 'STORED_LEDGER_BREAKDOWN';
                        let txBreakdown = tx.taxBreakdown;
                        if (!txBreakdown && tx.relatedPurchaseId) {
                            const purchase = await Purchase.findById(tx.relatedPurchaseId).session(session).lean();
                            if (purchase) {
                                txBreakdown = {
                                    sellingPrice: purchase.amount,
                                    basePrice: purchase.basePrice,
                                    gstAmount: purchase.gstAmount,
                                    platformCommission: purchase.platformCommission,
                                    gstOnCommission: purchase.gstOnCommission,
                                    tdsAmount: purchase.tdsAmount,
                                    tcsAmount: purchase.tcsAmount,
                                    creatorPayout: purchase.creatorPayout,
                                };
                                taxSource = 'PURCHASE_LOOKUP';
                            }
                        }
                        if (!txBreakdown && tx.amount > 0) {
                            const estSelling = Math.round(tx.amount / 0.612985);
                            txBreakdown = calculateTaxBreakdown(estSelling);
                            taxSource = 'RATIO_FALLBACK';
                        }
                        if (txBreakdown) {
                            console.log(`[PAYOUT_TAX_STRATEGY] TxnID: ${tx._id} | Amount: ₹${tx.amount} | TaxSource: ${taxSource} | SellingPrice: ₹${txBreakdown.sellingPrice}`);
                            rawSelling += txBreakdown.sellingPrice || 0;
                            rawBase += txBreakdown.basePrice || 0;
                            rawGst += txBreakdown.gstAmount || 0;
                            rawComm += txBreakdown.platformCommission || 0;
                            rawCommGst += txBreakdown.gstOnCommission || 0;
                            rawTds += txBreakdown.tdsAmount || 0;
                            rawTcs += txBreakdown.tcsAmount || 0;
                            rawNet += txBreakdown.creatorPayout || tx.amount || 0;
                        }
                    }

                    let totalSellingPrice = 0, totalBasePrice = 0, totalGstCollected = 0;
                    let totalPlatformCommission = 0, totalGstOnCommission = 0;
                    let totalTdsDeducted = 0, totalTcsDeducted = 0;
                    let calcMethod = 'AGGREGATED_TRANSACTIONS';

                    if (rawNet > 0 && grossAmount > 0) {
                        const scale = grossAmount / rawNet;
                        totalSellingPrice = Number((rawSelling * scale).toFixed(2));
                        totalBasePrice = Number((rawBase * scale).toFixed(2));
                        totalGstCollected = Number((rawGst * scale).toFixed(2));
                        totalPlatformCommission = Number((rawComm * scale).toFixed(2));
                        totalGstOnCommission = Number((rawCommGst * scale).toFixed(2));
                        totalTdsDeducted = Number((rawTds * scale).toFixed(2));
                        totalTcsDeducted = Number((rawTcs * scale).toFixed(2));
                    } else if (grossAmount > 0) {
                        calcMethod = 'DIRECT_RATIO_SCALE';
                        const estSelling = Math.round(grossAmount / 0.612985);
                        const calc = calculateTaxBreakdown(estSelling);
                        totalSellingPrice = calc.sellingPrice;
                        totalBasePrice = calc.basePrice;
                        totalGstCollected = calc.gstAmount;
                        totalPlatformCommission = calc.platformCommission;
                        totalGstOnCommission = calc.gstOnCommission;
                        totalTdsDeducted = calc.tdsAmount;
                        totalTcsDeducted = calc.tcsAmount;
                    }

                    console.log(`[PAYOUT_CALC_METHOD] Wallet: ${freshWallet._id} | Gross: ₹${grossAmount} | Method: ${calcMethod} | RawNet: ₹${rawNet}`);

                    // EMAIL GUARD: Check email address FIRST before finalizing
                    const user = await User.findById(freshWallet.userId).select('contact email userName channelName').lean();
                    const creatorEmail = user?.contact || user?.email;
                    if (!creatorEmail || !creatorEmail.includes('@')) {
                        console.error(`❌ [PAYOUT_EMAIL_GUARD] Creator ${freshWallet.userId} has no valid email address. Aborting payout to preserve wallet balance.`);
                        throw new Error(`Creator email address is missing/invalid. Payout aborted to protect wallet balance.`);
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

                    // Send email INSIDE transaction scope — if mail fails, throw error so MongoDB transaction rolls back balance!
                    try {
                        await sendAdminEmail('payoutInitiated', creatorEmail, {
                            creatorName: user.channelName || user.userName || 'Creator',
                            netAmount,
                            grossAmount,
                            payoutMonth
                        });
                        console.log(`✅ [PAYOUT_EMAIL_GUARD] Payout initiation email sent successfully to ${creatorEmail}`);
                    } catch (mailErr) {
                        console.error(`❌ [PAYOUT_EMAIL_GUARD] Email sending failed to ${creatorEmail}:`, mailErr);
                        throw new Error(`Payout initiation email failed to send to ${creatorEmail}: ${mailErr.message}. Rolling back payout and preserving wallet balance.`);
                    }

                    results.processed++;
                    console.log(`✅ [PAYOUT_BULK_SUCCESS] Created Payout ${createdPayout._id} | User: ${freshWallet.userId} | Gross: ₹${grossAmount} | Net: ₹${netAmount}`);
                });
            } catch (err) {
                results.failed++;
                results.errors.push({ walletId: wallet._id.toString(), error: err.message });
                console.error(`❌ [PAYOUT_BULK_ERROR] Payout failed for wallet ${wallet._id}:`, err);
            } finally {
                await session.endSession();
            }
        }

        console.log(`✅ [PAYOUT_JOB_BULK_COMPLETE] Processed: ${results.processed} | Skipped: ${results.skipped} | Failed: ${results.failed}`);
        console.log(`=================== [PAYOUT_JOB_BULK_END] ===================\n`);
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
            .populate('userId', 'userName channelName contact email')
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
        console.log(`\n=================== [PAYOUT_JOB_SINGLE_INIT] ===================`);
        console.log(`Target User ID: ${userId}`);

        if (!userId) {
            return res.status(400).json({ error: "userId is required" });
        }

        const pendingPayout = await Payout.findOne({ userId, status: 'pending_settlement' });
        if (pendingPayout) {
            console.error(`[PAYOUT_SINGLE_REJECTED] Previous settlement (${pendingPayout._id}) is still pending for User ${userId}`);
            return res.status(400).json({ error: "Cannot initiate payout while a previous settlement is pending for this creator" });
        }

        const wallet = await SecondaryWallet.findOne({ userId });
        if (!wallet || wallet.balance <= 0) {
            console.error(`[PAYOUT_SINGLE_REJECTED] Creator ${userId} has no withdrawable secondary wallet balance (Balance: ₹${wallet?.balance || 0})`);
            return res.status(400).json({ error: "Creator has no withdrawable secondary wallet balance" });
        }

        const kyc = await KycDetails.findOne({ userId });
        if (!kyc || kyc.kycStatus !== 'verified') {
            console.error(`[PAYOUT_SINGLE_REJECTED] Creator ${userId} KYC is not verified (Status: ${kyc?.kycStatus || 'none'})`);
            return res.status(400).json({ error: "Creator KYC is not verified. Payouts can only be initiated for KYC-verified creators." });
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

                // Calculate tax aggregates from creator's earning transactions since last payout
                const lastPayoutDoc = await Payout.findOne({
                    walletId: freshWallet._id,
                    status: { $in: ['pending_settlement', 'completed'] },
                }).sort({ createdAt: -1 }).session(session).lean();

                const txnQuery = {
                    walletId: freshWallet._id,
                    type: 'ppv_earning_credit',
                    status: 'completed',
                };
                if (lastPayoutDoc && lastPayoutDoc.createdAt) {
                    txnQuery.createdAt = { $gt: lastPayoutDoc.createdAt };
                }

                const earningTxns = await WalletTransaction.find(txnQuery).session(session).lean();

                let rawSelling = 0, rawBase = 0, rawGst = 0, rawComm = 0, rawCommGst = 0, rawTds = 0, rawTcs = 0, rawNet = 0;

                for (const tx of earningTxns) {
                    let taxSource = 'STORED_LEDGER_BREAKDOWN';
                    let txBreakdown = tx.taxBreakdown;
                    if (!txBreakdown && tx.relatedPurchaseId) {
                        const purchase = await Purchase.findById(tx.relatedPurchaseId).session(session).lean();
                        if (purchase) {
                            txBreakdown = {
                                sellingPrice: purchase.amount,
                                basePrice: purchase.basePrice,
                                gstAmount: purchase.gstAmount,
                                platformCommission: purchase.platformCommission,
                                gstOnCommission: purchase.gstOnCommission,
                                tdsAmount: purchase.tdsAmount,
                                tcsAmount: purchase.tcsAmount,
                                creatorPayout: purchase.creatorPayout,
                            };
                            taxSource = 'PURCHASE_LOOKUP';
                        }
                    }
                    if (!txBreakdown && tx.amount > 0) {
                        const estSelling = Math.round(tx.amount / 0.612985);
                        txBreakdown = calculateTaxBreakdown(estSelling);
                        taxSource = 'RATIO_FALLBACK';
                    }
                    if (txBreakdown) {
                        console.log(`[PAYOUT_TAX_STRATEGY] Single Payout | TxnID: ${tx._id} | Amount: ₹${tx.amount} | TaxSource: ${taxSource} | SellingPrice: ₹${txBreakdown.sellingPrice}`);
                        rawSelling += txBreakdown.sellingPrice || 0;
                        rawBase += txBreakdown.basePrice || 0;
                        rawGst += txBreakdown.gstAmount || 0;
                        rawComm += txBreakdown.platformCommission || 0;
                        rawCommGst += txBreakdown.gstOnCommission || 0;
                        rawTds += txBreakdown.tdsAmount || 0;
                        rawTcs += txBreakdown.tcsAmount || 0;
                        rawNet += txBreakdown.creatorPayout || tx.amount || 0;
                    }
                }

                let totalSellingPrice = 0, totalBasePrice = 0, totalGstCollected = 0;
                let totalPlatformCommission = 0, totalGstOnCommission = 0;
                let totalTdsDeducted = 0, totalTcsDeducted = 0;
                let calcMethod = 'AGGREGATED_TRANSACTIONS';

                if (rawNet > 0 && grossAmount > 0) {
                    const scale = grossAmount / rawNet;
                    totalSellingPrice = Number((rawSelling * scale).toFixed(2));
                    totalBasePrice = Number((rawBase * scale).toFixed(2));
                    totalGstCollected = Number((rawGst * scale).toFixed(2));
                    totalPlatformCommission = Number((rawComm * scale).toFixed(2));
                    totalGstOnCommission = Number((rawCommGst * scale).toFixed(2));
                    totalTdsDeducted = Number((rawTds * scale).toFixed(2));
                    totalTcsDeducted = Number((rawTcs * scale).toFixed(2));
                } else if (grossAmount > 0) {
                    calcMethod = 'DIRECT_RATIO_SCALE';
                    const estSelling = Math.round(grossAmount / 0.612985);
                    const calc = calculateTaxBreakdown(estSelling);
                    totalSellingPrice = calc.sellingPrice;
                    totalBasePrice = calc.basePrice;
                    totalGstCollected = calc.gstAmount;
                    totalPlatformCommission = calc.platformCommission;
                    totalGstOnCommission = calc.gstOnCommission;
                    totalTdsDeducted = calc.tdsAmount;
                    totalTcsDeducted = calc.tcsAmount;
                }

                console.log(`[PAYOUT_CALC_METHOD] Single Payout | User: ${userId} | Gross: ₹${grossAmount} | Method: ${calcMethod} | RawNet: ₹${rawNet}`);

                // EMAIL GUARD: Verify email BEFORE finalizing payout
                const user = await User.findById(userId).select('contact email userName channelName').lean();
                const creatorEmail = user?.contact || user?.email;
                if (!creatorEmail || !creatorEmail.includes('@')) {
                    console.error(`❌ [PAYOUT_EMAIL_GUARD] Creator ${userId} has no valid email address. Aborting single payout to protect wallet balance.`);
                    throw new Error(`Creator email address is missing/invalid. Single payout aborted to protect wallet balance.`);
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

                // Send email INSIDE transaction scope — if mail fails, throw error so MongoDB transaction rolls back balance!
                try {
                    await sendAdminEmail('payoutInitiated', creatorEmail, {
                        creatorName: user.channelName || user.userName || 'Creator',
                        netAmount: createdPayout.netAmount,
                        grossAmount: createdPayout.grossAmount,
                        payoutMonth
                    });
                    console.log(`✅ [PAYOUT_EMAIL_GUARD] Single payout initiation email sent successfully to ${creatorEmail}`);
                } catch (mailErr) {
                    console.error(`❌ [PAYOUT_EMAIL_GUARD] Email sending failed to ${creatorEmail}:`, mailErr);
                    throw new Error(`Payout initiation email failed to send to ${creatorEmail}: ${mailErr.message}. Rolling back payout and preserving wallet balance.`);
                }

                console.log(`✅ [PAYOUT_SINGLE_SUCCESS] Created Payout ${createdPayout._id} | User: ${userId} | Gross: ₹${grossAmount} | Net: ₹${netAmount}`);
            });

            // Send notification email to creator
            const user = await User.findById(userId).select('contact email userName channelName').lean();
            const creatorEmail = user?.contact || user?.email;
            if (creatorEmail) {
                sendAdminEmail('payoutInitiated', creatorEmail, {
                    creatorName: user.channelName || user.userName || 'Creator',
                    netAmount: createdPayout.netAmount,
                    grossAmount: createdPayout.grossAmount,
                    payoutMonth
                }).catch(e => console.error('Single payout email error:', e));
            }

            console.log(`=================== [PAYOUT_JOB_SINGLE_END] ===================\n`);
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

        const purchaseTaxAgg = await Purchase.aggregate([
            {
                $match: {
                    purchasedAt: { $gte: startOfDay, $lte: endOfDay },
                    status: { $in: ['active', 'expired'] }
                }
            },
            {
                $group: {
                    _id: null,
                    totalSelling: { $sum: '$amount' },
                    totalBase: { $sum: { $ifNull: ['$basePrice', { $divide: ['$amount', 1.18] }] } },
                    totalGst: { $sum: { $ifNull: ['$gstAmount', { $subtract: ['$amount', { $divide: ['$amount', 1.18] }] }] } },
                    totalCommission: { $sum: { $ifNull: ['$platformCommission', { $multiply: ['$amount', 0.32] }] } },
                    totalGstCommission: { $sum: { $ifNull: ['$gstOnCommission', { $multiply: ['$amount', 0.0576] }] } },
                    totalTds: { $sum: { $ifNull: ['$tdsAmount', { $multiply: [{ $divide: ['$amount', 1.18] }, 0.001] }] } },
                    totalTcs: { $sum: { $ifNull: ['$tcsAmount', { $multiply: [{ $divide: ['$amount', 1.18] }, 0.01] }] } },
                }
            }
        ]);

        const tax = purchaseTaxAgg[0] || {};
        const gatewayPPV = tax.totalSelling || 0;

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
            totalW2Balance,
            totalGrossCollected: Number((tax.totalSelling || 0).toFixed(2)),
            totalBasePrice: Number((tax.totalBase || 0).toFixed(2)),
            totalGstCollected: Number((tax.totalGst || 0).toFixed(2)),
            totalPlatformCommission: Number((tax.totalCommission || 0).toFixed(2)),
            totalGstOnCommission: Number((tax.totalGstCommission || 0).toFixed(2)),
            totalTdsDeducted: Number((tax.totalTds || 0).toFixed(2)),
            totalTcsDeducted: Number((tax.totalTcs || 0).toFixed(2)),
        });
    } catch (error) {
        console.error('❌ Error getting daily payout stats:', error);
        return res.status(500).json({ error: 'Failed to fetch daily payout stats' });
    }
};

/**
 * POST /admin/payouts/:payoutId/complete — Mark settlement completed and send invoice email
 */
export const completePayoutSettlement = async (req, res) => {
    try {
        const { payoutId } = req.params;
        console.log(`\n=================== [SETTLEMENT_COMPLETE_INIT] ===================`);
        console.log(`Payout ID: ${payoutId}`);

        const payout = await Payout.findById(payoutId).populate('userId', 'userName channelName channelHandle contact email');
        if (!payout) return res.status(404).json({ error: 'Payout record not found' });
        if (payout.status === 'completed' && !req.body.forceResend) {
            console.log(`[SETTLEMENT_COMPLETE] Payout ${payoutId} already completed.`);
            return res.status(400).json({ error: 'Payout settlement is already marked as completed' });
        }

        const creatorEmail = payout.userId?.contact || payout.userId?.email;
        if (!creatorEmail || !creatorEmail.includes('@')) {
            console.error(`❌ [SETTLEMENT_EMAIL_GUARD] Creator ${payout.userId?._id} has no valid email address. ABORTING settlement completion.`);
            return res.status(400).json({ error: 'Settlement completion aborted: Creator email address is missing or invalid. Settlement remains pending_settlement.' });
        }

        const kyc = await KycDetails.findOne({ userId: payout.userId._id }).lean();
        let bankDetails = {};
        if (kyc) {
            const dec = decryptBankDetails(kyc);
            bankDetails = {
                accountHolderName: dec.accountHolderName || payout.userId.channelName || payout.userId.userName,
                bankName: dec.bankName || payout.bankName || '',
                accountNumber: dec.bankAccountNumber ? '••••' + dec.bankAccountNumber.slice(-4) : '',
                ifscCode: dec.ifscCode || '',
            };
        }

        // EMAIL GUARD: Send PDF Settlement Invoice FIRST. If mail fails, DO NOT mark completed!
        try {
            await sendAdminEmail('payoutCompleted', creatorEmail, {
                creatorName: payout.userId.channelName || payout.userId.userName || 'Creator',
                userName: payout.userId.userName || '',
                userHandle: payout.userId.channelHandle || '',
                gstin: kyc?.gstNumber || '',
                netAmount: payout.netAmount,
                grossAmount: payout.grossAmount,
                payoutMonth: payout.payoutMonth,
                totalSellingPrice: payout.totalSellingPrice || payout.grossAmount,
                totalBasePrice: payout.totalBasePrice || 0,
                totalGstCollected: payout.totalGstCollected || 0,
                totalPlatformCommission: payout.totalPlatformCommission || 0,
                totalGstOnCommission: payout.totalGstOnCommission || 0,
                totalTdsDeducted: payout.totalTdsDeducted || 0,
                totalTcsDeducted: payout.totalTcsDeducted || 0,
                bankDetails,
            });
            console.log(`✅ [SETTLEMENT_EMAIL_GUARD] PDF Settlement Tax Invoice sent successfully to ${creatorEmail}`);
        } catch (mailErr) {
            console.error(`❌ [SETTLEMENT_EMAIL_GUARD] Failed to send email to ${creatorEmail}:`, mailErr);
            return res.status(500).json({
                error: `Settlement completion aborted: Failed to send invoice email to creator (${mailErr.message}). Settlement status remains pending_settlement.`
            });
        }

        // Status is updated ONLY AFTER email sending succeeds
        payout.status = 'completed';
        payout.completedAt = new Date();
        await payout.save();

        console.log(`✅ [SETTLEMENT_COMPLETE_SUCCESS] Payout ${payoutId} marked as completed for User ${payout.userId?._id} | Net Transferred: ₹${payout.netAmount}`);
        console.log(`=================== [SETTLEMENT_COMPLETE_END] ===================\n`);
        return res.json({ success: true, message: 'Payout marked as completed and settlement invoice email sent', payout });
    } catch (err) {
        console.error('Error completing payout settlement:', err);
        return res.status(500).json({ error: 'Failed to complete payout settlement' });
    }
};

/**
 * POST /admin/payouts/complete-bulk — Mark all pending settlements as completed and send invoice emails
 */
export const completeBulkPayoutSettlement = async (req, res) => {
    try {
        const { month, payoutIds } = req.body;
        let query = { status: 'pending_settlement' };

        if (payoutIds && Array.isArray(payoutIds) && payoutIds.length > 0) {
            query._id = { $in: payoutIds };
        } else if (month) {
            query.payoutMonth = { $regex: new RegExp(`^${month}`) };
        }

        const pendingPayouts = await Payout.find(query).populate('userId', 'userName channelName channelHandle contact email');
        if (pendingPayouts.length === 0) {
            return res.json({ success: true, message: 'No pending payout settlements found to complete', completedCount: 0 });
        }

        let completedCount = 0;
        let failedCount = 0;
        const failedEmails = [];

        for (const payout of pendingPayouts) {
            const creatorEmail = payout.userId?.contact || payout.userId?.email;
            if (!creatorEmail || !creatorEmail.includes('@')) {
                console.error(`❌ [BULK_SETTLEMENT_EMAIL_GUARD] Creator ${payout.userId?._id} missing email. Skipping completion.`);
                failedCount++;
                failedEmails.push({ payoutId: payout._id, reason: 'Missing email' });
                continue;
            }

            const kyc = await KycDetails.findOne({ userId: payout.userId._id }).lean();
            let bankDetails = {};
            if (kyc) {
                const dec = decryptBankDetails(kyc);
                bankDetails = {
                    accountHolderName: dec.accountHolderName || payout.userId.channelName || payout.userId.userName,
                    bankName: dec.bankName || payout.bankName || '',
                    accountNumber: dec.bankAccountNumber ? '••••' + dec.bankAccountNumber.slice(-4) : '',
                    ifscCode: dec.ifscCode || '',
                };
            }

            try {
                await sendAdminEmail('payoutCompleted', creatorEmail, {
                    creatorName: payout.userId.channelName || payout.userId.userName || 'Creator',
                    userName: payout.userId.userName || '',
                    userHandle: payout.userId.channelHandle || '',
                    gstin: kyc?.gstNumber || '',
                    netAmount: payout.netAmount,
                    grossAmount: payout.grossAmount,
                    payoutMonth: payout.payoutMonth,
                    totalSellingPrice: payout.totalSellingPrice || payout.grossAmount,
                    totalBasePrice: payout.totalBasePrice || 0,
                    totalGstCollected: payout.totalGstCollected || 0,
                    totalPlatformCommission: payout.totalPlatformCommission || 0,
                    totalGstOnCommission: payout.totalGstOnCommission || 0,
                    totalTdsDeducted: payout.totalTdsDeducted || 0,
                    totalTcsDeducted: payout.totalTcsDeducted || 0,
                    bankDetails,
                });

                // Update status ONLY AFTER email sending succeeds
                payout.status = 'completed';
                payout.completedAt = new Date();
                await payout.save();
                completedCount++;
            } catch (mailErr) {
                console.error(`❌ [BULK_SETTLEMENT_EMAIL_GUARD] Email failed for ${payout._id}:`, mailErr);
                failedCount++;
                failedEmails.push({ payoutId: payout._id, error: mailErr.message });
            }
        }

        return res.json({
            success: true,
            message: `Successfully completed ${completedCount} payout settlement(s) with invoice emails sent. ${failedCount} failed.`,
            completedCount,
            failedCount,
            failedEmails,
        });
    } catch (error) {
        console.error('❌ Error executing bulk settlement completion:', error);
        res.status(500).json({ error: 'Failed to complete bulk payout settlement' });
    }
};

/**
 * POST /admin/payouts/:payoutId/resend-email
 * Resends the settlement completed email with attached PDF invoice to creator.
 */
export const resendSettlementEmail = async (req, res) => {
    try {
        const payoutId = req.params.payoutId || req.params.id || req.body.payoutId;
        console.log(`\n=================== [RESEND_SETTLEMENT_EMAIL_INIT] ===================`);
        console.log(`Payout ID: ${payoutId}`);

        if (!payoutId) {
            return res.status(400).json({ error: 'payoutId is required' });
        }

        const payout = await Payout.findById(payoutId).populate('userId', 'userName channelName channelHandle contact email');
        if (!payout) {
            return res.status(404).json({ error: 'Payout record not found' });
        }

        const creatorEmail = payout.userId?.contact || payout.userId?.email;
        if (!creatorEmail || !creatorEmail.includes('@')) {
            console.error(`❌ [RESEND_EMAIL_GUARD] Creator ${payout.userId?._id} has no valid email address.`);
            return res.status(400).json({ error: 'Creator does not have a valid email address on file.' });
        }

        const kyc = await KycDetails.findOne({ userId: payout.userId._id }).lean();
        let bankDetails = {};
        if (kyc) {
            const dec = decryptBankDetails(kyc);
            bankDetails = {
                accountHolderName: dec.accountHolderName || payout.userId.channelName || payout.userId.userName,
                bankName: dec.bankName || payout.bankName || '',
                accountNumber: dec.bankAccountNumber ? '••••' + dec.bankAccountNumber.slice(-4) : '',
                ifscCode: dec.ifscCode || '',
            };
        }

        console.log(`[RESEND_EMAIL_ATTEMPT] Sending PDF Settlement Invoice to ${creatorEmail}...`);
        await sendAdminEmail('payoutCompleted', creatorEmail, {
            creatorName: payout.userId.channelName || payout.userId.userName || 'Creator',
            userName: payout.userId.userName || '',
            userHandle: payout.userId.channelHandle || '',
            gstin: kyc?.gstNumber || '',
            netAmount: payout.netAmount,
            grossAmount: payout.grossAmount,
            payoutMonth: payout.payoutMonth,
            totalSellingPrice: payout.totalSellingPrice || payout.grossAmount,
            totalBasePrice: payout.totalBasePrice || 0,
            totalGstCollected: payout.totalGstCollected || 0,
            totalPlatformCommission: payout.totalPlatformCommission || 0,
            totalGstOnCommission: payout.totalGstOnCommission || 0,
            totalTdsDeducted: payout.totalTdsDeducted || 0,
            totalTcsDeducted: payout.totalTcsDeducted || 0,
            bankDetails,
        });

        console.log(`✅ [RESEND_EMAIL_SUCCESS] PDF Settlement Invoice resent to ${creatorEmail} for Payout ${payoutId}`);
        console.log(`=================== [RESEND_SETTLEMENT_EMAIL_END] ===================\n`);

        return res.json({
            success: true,
            message: `Settlement PDF invoice email resent successfully to ${creatorEmail}`,
            payoutId: payout._id
        });
    } catch (error) {
        console.error('❌ [RESEND_EMAIL_ERROR] Failed to resend settlement email:', error);
        return res.status(500).json({ error: `Failed to resend settlement email: ${error.message}` });
    }
};

/**
 * GET /admin/creator/:id/invoices
 * Fetch all payout settlement invoices stored in AWS S3 for a creator.
 * Query params: month (e.g. '2026-07'), sort ('desc' | 'asc')
 */
export const getCreatorInvoices = async (req, res) => {
    try {
        const { id } = req.params;
        const { month, sort = 'desc' } = req.query;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'Invalid creator ID' });
        }

        const filter = { userId: id };
        if (month) {
            filter.payoutMonth = month;
        }

        const sortOrder = sort === 'asc' ? 1 : -1;
        const payouts = await Payout.find(filter).sort({ createdAt: sortOrder }).lean();
        const cdnUrl = process.env.VITE_CDN_URL || process.env.CDN_URL || 'https://cini-shine.s3.us-east-1.amazonaws.com';

        const invoices = payouts.map(p => {
            let pdfUrl = p.invoiceUrl;
            if (!pdfUrl && p.invoiceS3Key) {
                pdfUrl = `${cdnUrl}/${p.invoiceS3Key}`;
            }
            return {
                payoutId: p._id,
                payoutMonth: p.payoutMonth,
                status: p.status,
                grossAmount: p.grossAmount,
                netAmount: p.netAmount,
                feeAmount: p.feeAmount,
                taxBreakdown: {
                    totalSellingPrice: p.totalSellingPrice || p.grossAmount,
                    totalBasePrice: p.totalBasePrice || 0,
                    totalGstCollected: p.totalGstCollected || 0,
                    totalPlatformCommission: p.totalPlatformCommission || 0,
                    totalGstOnCommission: p.totalGstOnCommission || 0,
                    totalTdsDeducted: p.totalTdsDeducted || 0,
                    totalTcsDeducted: p.totalTcsDeducted || 0,
                },
                invoiceS3Key: p.invoiceS3Key || null,
                invoiceUrl: pdfUrl || null,
                createdAt: p.createdAt,
                completedAt: p.completedAt,
            };
        });

        return res.json({
            success: true,
            count: invoices.length,
            invoices,
        });
    } catch (err) {
        console.error('Error fetching creator invoices:', err);
        return res.status(500).json({ error: 'Failed to fetch creator invoices' });
    }
};
