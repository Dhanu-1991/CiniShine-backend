/**
 * Wallet Controller
 *
 * Endpoints:
 * - GET  /wallets                     — Get user's wallets (primary + secondary if exists)
 * - GET  /wallets/:walletId/transactions — Paginated transaction history
 * - POST /wallets/recharge            — Initiate wallet recharge via Cashfree
 * - POST /wallets/transfer            — Transfer from secondary to primary wallet
 * - POST /wallets/kyc                 — Submit/edit KYC details
 * - POST /wallets/purchase-ppv        — Purchase PPV content using wallet balance
 *
 * REFACTORED: Uses PrimaryWallet + SecondaryWallet + KycDetails (separate models)
 */
import mongoose from 'mongoose';
import User from '../../models/user.model.js';
import PrimaryWallet from '../../models/primaryWallet.model.js';
import SecondaryWallet from '../../models/secondaryWallet.model.js';
import KycDetails from '../../models/kycDetails.model.js';
import WalletTransaction from '../../models/walletTransaction.model.js';
import Purchase from '../../models/purchase.model.js';
import {
    ensurePrimaryWallet,
    ensureSecondaryWallet,
    executePpvPurchase,
    executeTransfer,
    createPendingRechargeRecord,
} from '../../utils/walletService.js';
import { encryptBankDetails } from '../../utils/encryption.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import Content from '../../models/content.model.js';
import { sendOtpToEmail } from '../auth-controllers/services/otpServiceEmail.js';
import { sendPpvRentalEmail } from '../../services/paymentEmailService.js';
import { calculateTaxBreakdown } from '../../utils/taxCalculator.js';
import PaymentDetails from '../../models/payment.details.model.js';
import { Cashfree, CFEnvironment } from 'cashfree-pg';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// Razorpay instance (lazy — only used when ACTIVE_PAYMENT_GATEWAY=razorpay)
const getRazorpayInstance = () => new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Initialize Cashfree
const cfEnv = process.env.CASHFREE_MODE?.trim() === 'production'
    ? CFEnvironment.PRODUCTION
    : CFEnvironment.SANDBOX;
const cashfree = new Cashfree(cfEnv, process.env.CF_CLIENT_ID?.trim(), process.env.CF_CLIENT_SECRET?.trim());

export const getMyWallets = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        // Ensure primary wallet exists (lazy creation for existing users)
        const primaryWallet = await ensurePrimaryWallet(userId);
        const secondaryWallet = await SecondaryWallet.findOne({ userId });
        const kycDetails = await KycDetails.findOne({ userId });

        const wallets = {
            primary: {
                _id: primaryWallet._id,
                type: 'primary',
                balance: primaryWallet.balance,
                currency: primaryWallet.currency,
                isPinSet: primaryWallet.isPinSet || false,
                isPinLocked: primaryWallet.isPinLocked || false,
                failedPinAttempts: primaryWallet.failedPinAttempts || 0,
                label: 'In-App Credit',
                withdrawable: false,
            },
        };

        if (secondaryWallet) {
            wallets.settlement = {
                _id: secondaryWallet._id,
                type: 'secondary',
                balance: secondaryWallet.balance,
                currency: secondaryWallet.currency,
                kycStatus: kycDetails?.kycStatus || 'not_started',
                label: 'Payout Balance',
                withdrawable: true,
                note: 'Paid out automatically at month-end to your bank account, minus 1% maintenance fee.',
            };
        } else {
            wallets.settlement = null;
            wallets.kycRequired = true;
        }

        // Include KYC status separately for frontend guards
        wallets.kyc = kycDetails ? {
            status: kycDetails.kycStatus,
            submittedAt: kycDetails.submittedAt,
            lastEditedAt: kycDetails.lastEditedAt,
            rejectionReason: kycDetails.rejectionReason,
            isGstHolder: kycDetails.isGstHolder || false,
            gstNumber: kycDetails.gstNumber || null,
        } : null;

        res.json({ wallets });
    } catch (error) {
        console.error('❌ Error fetching wallets:', error);
        res.status(500).json({ error: 'Failed to fetch wallet information' });
    }
};

/**
 * GET /wallets/:walletId/transactions — Paginated transaction history
 *
 * PRIVACY: For secondary wallet transactions, relatedBuyerId is NEVER
 * included in the response. Creators see aggregate purchase data only.
 */
export const getWalletTransactions = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { walletId } = req.params;
        const { filter, date, month } = req.query;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;

        if (!walletId || !mongoose.Types.ObjectId.isValid(walletId)) {
            return res.status(400).json({ error: 'Invalid wallet ID' });
        }

        // Verify wallet ownership — check both models
        let wallet = await PrimaryWallet.findById(walletId);
        let walletType = 'primary';
        if (!wallet) {
            wallet = await SecondaryWallet.findById(walletId);
            walletType = 'secondary';
        }
        if (!wallet || wallet.userId.toString() !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Only show completed transactions to users
        const query = { walletId, status: 'completed' };

        if (filter && filter !== 'all') {
            if (filter === 'payouts' || filter === 'payout') {
                query.type = { $in: ['payout', 'payout_fee'] };
            } else if (filter === 'transfer_to_wallet1' || filter === 'transfer_from_settlement') {
                query.type = 'transfer_from_settlement';
            } else if (filter === 'transfer_in' || filter === 'transfer_to_primary') {
                query.type = 'transfer_to_primary';
            } else if (filter === 'recharge') {
                query.type = 'recharge';
            } else if (filter === 'ppv_purchase') {
                query.type = 'ppv_purchase_debit';
            } else if (filter === 'ppv_earning') {
                query.type = 'ppv_earning_credit';
            } else if (filter === 'engagement_earning') {
                query.type = 'engagement_earning_credit';
            } else {
                query.type = filter;
            }
        }

        if (date) {
            const [y, m, d] = date.split('-').map(Number);
            const start = new Date(y, m - 1, d, 0, 0, 0, 0);
            const end = new Date(y, m - 1, d, 23, 59, 59, 999);
            query.createdAt = { $gte: start, $lte: end };
        } else if (month) {
            const [y, m] = month.split('-').map(Number);
            const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
            const end = new Date(y, m, 0, 23, 59, 59, 999);
            query.createdAt = { $gte: start, $lte: end };
        }

        const [transactions, total] = await Promise.all([
            WalletTransaction.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('relatedContentId', 'title contentType thumbnailKey')
                .lean(),
            WalletTransaction.countDocuments(query),
        ]);

        // PRIVACY: Strip relatedBuyerId from secondary wallet transactions
        if (walletType === 'secondary') {
            for (const txn of transactions) {
                delete txn.relatedBuyerId;
                if (txn.type === 'ppv_earning_credit') {
                    if (!txn.taxBreakdown && txn.relatedPurchaseId) {
                        const purchase = await Purchase.findById(txn.relatedPurchaseId).lean();
                        if (purchase) {
                            txn.taxBreakdown = {
                                sellingPrice: purchase.amount,
                                basePrice: purchase.basePrice,
                                gstAmount: purchase.gstAmount,
                                platformCommission: purchase.platformCommission,
                                gstOnCommission: purchase.gstOnCommission,
                                tdsAmount: purchase.tdsAmount,
                                tcsAmount: purchase.tcsAmount,
                                creatorPayout: purchase.creatorPayout,
                            };
                        }
                    }
                    if (!txn.taxBreakdown && txn.amount) {
                        txn.taxBreakdown = calculateTaxBreakdown(txn.amount);
                    }
                }
            }
        }

        res.json({
            transactions,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error('❌ Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
};

/**
 * POST /wallets/recharge — Initiate wallet recharge
 * Gateway is determined by ACTIVE_PAYMENT_GATEWAY env var (razorpay | cashfree).
 */
export const rechargeInit = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { amount } = req.body;
        const numAmount = Number(amount);

        console.log(`\n=================== [RECHARGE_INIT] ===================`);
        console.log(`User: ${userId} | Requested Amount: ₹${numAmount}`);

        if (!numAmount || numAmount < 1) {
            console.error(`[RECHARGE_INIT] Rejected: Minimum recharge amount is ₹1 (Got ₹${numAmount})`);
            return res.status(400).json({ error: 'Minimum recharge amount is ₹1' });
        }

        await ensurePrimaryWallet(userId);

        const gateway = process.env.ACTIVE_PAYMENT_GATEWAY?.toLowerCase() || 'cashfree';
        const User = mongoose.model('User');
        const user = await User.findById(userId).select('userName channelName email contact').lean();

        // ─── RAZORPAY BRANCH ────────────────────────────────────────────────────
        if (gateway === 'razorpay') {
            console.log(`[RECHARGE_INIT] Gateway: RAZORPAY | User: ${userId}`);
            const rzp = getRazorpayInstance();
            const receiptId = `RECHARGE_${Date.now()}_${userId.toString().slice(-6)}`;

            const order = await rzp.orders.create({
                amount: Math.round(numAmount * 100), // paise
                currency: 'INR',
                receipt: receiptId,
                notes: {
                    type: 'wallet_recharge',
                    userId: userId.toString(),
                },
            });

            console.log(`[RECHARGE_INIT] Razorpay Order Created: ${order.id} | Amount: ₹${numAmount}`);

            // Store with Razorpay's order ID so verify can look it up
            await PaymentDetails.create({
                orderId: order.id,
                paymentId: 'PENDING_GENERATION',
                status: 'PENDING',
                amount: numAmount,
                currency: 'INR',
                userId,
                contentId: null, // wallet recharge
            });

            const customerEmail = user?.email || (user?.contact?.includes('@') ? user.contact : `${userId}@watchinit.com`);
            const customerPhone = (!user?.contact?.includes('@') && user?.contact) ? user.contact : '9876543210';

            console.log(`=================== [RECHARGE_INIT_SUCCESS] ===================\n`);
            return res.json({
                gateway: 'razorpay',
                order_id: order.id,
                amount: order.amount,
                currency: order.currency,
                key_id: process.env.RAZORPAY_KEY_ID,
                customer_name: user?.channelName || user?.userName || 'User',
                customer_email: customerEmail,
                customer_phone: customerPhone,
            });
        }

        // ─── CASHFREE BRANCH (default) ──────────────────────────────────────────
        console.log(`[RECHARGE_INIT] Gateway: CASHFREE | User: ${userId}`);
        const orderId = `RECHARGE_${Date.now()}_${userId.toString().slice(-6)}`;

        // Create pending initiation record (auto-expires in 24h if never completed)
        await createPendingRechargeRecord(userId, numAmount, orderId);

        const customerEmail = user?.email || (user?.contact?.includes('@') ? user.contact : `${userId}@watchinit.com`);
        const customerPhone = (!user?.contact?.includes('@') && user?.contact) ? user.contact : '9876543210';

        const orderRequest = {
            order_id: orderId,
            order_amount: numAmount,
            order_currency: 'INR',
            customer_details: {
                customer_id: userId.toString(),
                customer_name: user?.userName || 'User',
                customer_email: customerEmail,
                customer_phone: customerPhone,
            },
            order_meta: {
                return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/result?order_id=${orderId}`,
            },
            order_tags: {
                type: 'wallet_recharge',
                userId: userId.toString(),
            },
        };

        // Create a pending record in DB so payment-verify never sees null
        await PaymentDetails.create({
            orderId,
            paymentId: 'PENDING_GENERATION',
            status: 'PENDING',
            amount: numAmount,
            currency: 'INR',
            userId,
        });

        const response = await cashfree.PGCreateOrder(orderRequest);
        console.log(`[RECHARGE_INIT] Cashfree Order Created: ${orderId} | SessionID: ${response.data?.payment_session_id}`);
        console.log(`=================== [RECHARGE_INIT_SUCCESS] ===================\n`);

        return res.json({
            gateway: 'cashfree',
            success: true,
            orderId,
            paymentSessionId: response.data?.payment_session_id,
            orderAmount: numAmount,
        });
    } catch (error) {
        console.error('❌ [RECHARGE_INIT_ERROR]', error?.response?.data || error.message);
        const cfError = error?.response?.data?.message || error?.message || 'Unknown error';
        res.status(500).json({ error: `Failed to create recharge order: ${cfError}` });
    }
};

export const transferOtpStore = new Map();

// ── OTP Store TTL Cleanup (prevents memory leaks) ───────────────────────────
// Runs every 5 minutes to clear expired OTPs from all in-memory stores
setInterval(() => {
    const now = Date.now();
    const stores = [
        { name: 'transferOtpStore', store: transferOtpStore },
    ];
    // kycOtpStore and pinOtpStore are defined later, cleaned via same interval
    for (const { name, store } of stores) {
        let cleaned = 0;
        for (const [key, val] of store.entries()) {
            if (typeof val === 'object' && val.expiresAt && val.expiresAt < now) {
                store.delete(key);
                cleaned++;
            } else if (typeof val === 'number' && val < now) {
                store.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) console.log(`🧹 [OTP_CLEANUP] ${name}: removed ${cleaned} expired entries`);
    }
}, 5 * 60 * 1000);

/**
 * POST /wallets/transfer/send-otp — Send OTP for transferring Payout Balance to Wallet
 */
export const sendTransferOtp = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const user = await User.findById(userId).select('email contact userName').lean();
        const resolvedEmail = user?.email || (user?.contact && user.contact.includes('@') ? user.contact : null) || (req.body.email && req.body.email.includes('@') ? req.body.email.trim() : null);

        if (!user || !resolvedEmail) {
            return res.status(400).json({ error: 'Registered user email not found' });
        }

        // 30-second cooldown check
        const existing = transferOtpStore.get(userId);
        if (existing && existing.lastSentAt && (Date.now() - existing.lastSentAt < 30000)) {
            const waitSec = Math.ceil((30000 - (Date.now() - existing.lastSentAt)) / 1000);
            return res.status(429).json({
                error: `Please wait ${waitSec} seconds before requesting another OTP.`,
                retryAfterSec: waitSec
            });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        transferOtpStore.set(userId, {
            otp,
            expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
            lastSentAt: Date.now()
        });

        await sendOtpToEmail(resolvedEmail, otp, 'wallet_transfer');
        return res.json({
            success: true,
            message: `Wallet transfer verification OTP code sent to ${resolvedEmail}. Valid for 5 minutes.`,
            email: resolvedEmail,
        });
    } catch (err) {
        console.error('Error sending transfer OTP:', err);
        return res.status(500).json({ error: 'Failed to send wallet transfer OTP email' });
    }
};

/**
 * POST /wallets/transfer — Transfer from secondary to primary wallet (requires OTP)
 */
export const transferToWalletOne = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { amount, otp, confirmTransfer } = req.body;
        const numAmount = Number(amount);

        console.log(`[WALLET_TRANSFER_HTTP_REQ] User: ${userId} | Amount: ₹${numAmount} | Confirm: ${confirmTransfer}`);

        if (!numAmount || numAmount <= 0) {
            return res.status(400).json({ error: 'Transfer amount must be positive' });
        }

        // Require explicit confirmation
        if (confirmTransfer !== true) {
            return res.status(400).json({
                error: 'Transfer requires explicit confirmation',
                warning: 'This transfer is irreversible. Funds moved to Wallet become non-withdrawable in-app credit and cannot be transferred back or paid out to a bank account.',
                requiresConfirmation: true,
            });
        }

        // OTP Verification check
        if (!otp || String(otp).trim().length !== 6) {
            return res.status(400).json({ error: 'Valid 6-digit verification OTP code is required' });
        }

        const storedOtp = transferOtpStore.get(userId);
        if (!storedOtp || storedOtp.expiresAt < Date.now()) {
            return res.status(400).json({ error: 'OTP has expired or is invalid. Please request a new OTP.' });
        }

        if (storedOtp.otp !== String(otp).trim()) {
            return res.status(400).json({ error: 'Invalid OTP code. Please check your email.' });
        }

        transferOtpStore.delete(userId);

        const idempotencyKey = `transfer_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        const result = await executeTransfer(userId, numAmount, idempotencyKey);

        if (result.alreadyProcessed) {
            return res.json({ success: true, message: 'Transfer already processed', alreadyProcessed: true });
        }

        res.json({
            success: true,
            message: `₹${numAmount} transferred to Wallet`,
            transfer: {
                amount: numAmount,
                fromBalance: result.debitTxn.balanceAfter,
                toBalance: result.creditTxn.balanceAfter,
            },
        });
    } catch (error) {
        if (error.message?.includes('Insufficient')) {
            return res.status(400).json({ error: error.message });
        }
        console.error('❌ Error transferring funds:', error);
        res.status(500).json({ error: 'Failed to transfer funds' });
    }
};

export const kycOtpStore = new Map();

/**
 * POST /wallets/kyc/send-otp — Send 6-digit verification OTP to user email
 */
export const sendKycOtp = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const user = await User.findById(userId).select('email contact userName').lean();
        const resolvedEmail = user?.email || (user?.contact && user.contact.includes('@') ? user.contact : null) || (req.body.email && req.body.email.includes('@') ? req.body.email.trim() : null);

        if (!user || !resolvedEmail) {
            return res.status(400).json({ error: 'Registered user email not found' });
        }

        // Persist resolved email to user record if missing
        if (!user.email && resolvedEmail) {
            await User.findByIdAndUpdate(userId, { email: resolvedEmail });
        }

        const purpose = req.body?.purpose || req.query?.purpose || 'kyc_update';

        // 30-second cooldown check
        const existing = kycOtpStore.get(userId);
        if (existing && existing.lastSentAt && (Date.now() - existing.lastSentAt < 30000)) {
            const waitSec = Math.ceil((30000 - (Date.now() - existing.lastSentAt)) / 1000);
            return res.status(429).json({
                error: `Please wait ${waitSec} seconds before requesting another OTP.`,
                retryAfterSec: waitSec
            });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        kycOtpStore.set(userId, {
            otp,
            expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
            lastSentAt: Date.now()
        });

        await sendOtpToEmail(resolvedEmail, otp, purpose);
        const purposeLabel = (purpose === 'account_update' || purpose === 'accountUpdate') ? 'Profile Update' : 'KYC Verification';
        return res.json({
            success: true,
            message: `${purposeLabel} OTP code sent to ${resolvedEmail}. Valid for 5 minutes.`,
            email: resolvedEmail,
        });
    } catch (err) {
        console.error('Error sending KYC/Profile OTP:', err);
        return res.status(500).json({ error: 'Failed to send verification OTP email' });
    }
};

/**
 * POST /wallets/kyc/verify-otp — Verify entered 6-digit OTP code
 */
export const verifyKycOtp = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { otp } = req.body;
        if (!otp || String(otp).trim().length !== 6) {
            return res.status(400).json({ error: 'Valid 6-digit OTP code is required' });
        }

        const stored = kycOtpStore.get(userId);
        if (!stored || stored.expiresAt < Date.now()) {
            return res.status(400).json({ error: 'OTP has expired or is invalid. Please request a new OTP.' });
        }

        if (stored.otp !== String(otp).trim()) {
            return res.status(400).json({ error: 'Invalid OTP code. Please check your email.' });
        }

        // Grant 15-minute window for KYC / Profile update submission
        kycOtpStore.set(`verified_${userId}`, Date.now() + 15 * 60 * 1000);
        kycOtpStore.delete(userId);

        return res.json({ success: true, message: 'OTP verified successfully!' });
    } catch (err) {
        console.error('Error verifying OTP:', err);
        return res.status(500).json({ error: 'Failed to verify OTP' });
    }
};

/**
 * POST /wallets/kyc — Submit or edit KYC details.
 */
export const submitKyc = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        // Enforce OTP Verification check
        const verifiedUntil = kycOtpStore.get(`verified_${userId}`);
        if (!verifiedUntil || verifiedUntil < Date.now()) {
            return res.status(400).json({ error: 'Email OTP verification is required before submitting KYC details' });
        }

        const { bankAccountNumber, bankName, ifscCode, accountHolderName, kycDocumentType, isGstHolder, gstNumber } = req.body;

        // Validate required fields
        if (!bankAccountNumber || !bankName || !ifscCode || !accountHolderName) {
            return res.status(400).json({ error: 'All bank details are required: account number, bank name, IFSC, account holder name' });
        }
        if (!kycDocumentType || !['passbook', 'cancelled_cheque'].includes(kycDocumentType)) {
            return res.status(400).json({ error: 'Document type must be "passbook" or "cancelled_cheque"' });
        }

        const kycDocFile = req.files?.['kycDocument']?.[0] || req.file;
        const gstCertFile = req.files?.['gstCertificate']?.[0];

        if (!kycDocFile) {
            return res.status(400).json({ error: 'KYC document (passbook or cancelled cheque image/PDF) is required' });
        }

        const isGst = isGstHolder === 'true' || isGstHolder === true;
        if (isGst && !gstNumber?.trim()) {
            return res.status(400).json({ error: 'GST Number is required when registered as a GST holder' });
        }

        const kycBucket = process.env.S3_BUCKET;

        // Upload primary KYC document to S3
        const docExt = kycDocFile.originalname?.split('.').pop()?.toLowerCase() || 'jpg';
        const kycDocumentKey = `kyc-documents/${userId}/${uuidv4()}.${docExt}`;

        await s3Client.send(new PutObjectCommand({
            Bucket: kycBucket,
            Key: kycDocumentKey,
            Body: kycDocFile.buffer,
            ContentType: kycDocFile.mimetype,
            ServerSideEncryption: 'AES256',
        }));

        // Upload GST certificate to S3 if provided
        let gstCertificateKey = null;
        if (isGst && gstCertFile) {
            const gstExt = gstCertFile.originalname?.split('.').pop()?.toLowerCase() || 'jpg';
            gstCertificateKey = `gst-certificates/${userId}/${uuidv4()}.${gstExt}`;

            await s3Client.send(new PutObjectCommand({
                Bucket: kycBucket,
                Key: gstCertificateKey,
                Body: gstCertFile.buffer,
                ContentType: gstCertFile.mimetype,
                ServerSideEncryption: 'AES256',
            }));
        }

        // Encrypt bank details
        const encryptedFields = encryptBankDetails({ bankAccountNumber, bankName, ifscCode, accountHolderName });

        // Check existing KYC
        const existingKyc = await KycDetails.findOne({ userId });
        const isEdit = !!existingKyc;

        const kycData = {
            ...encryptedFields,
            kycDocumentKey,
            kycDocumentType,
            isGstHolder: isGst,
            gstNumber: isGst ? gstNumber.trim().toUpperCase() : null,
            gstCertificateKey: isGst ? (gstCertificateKey || existingKyc?.gstCertificateKey || null) : null,
            kycStatus: 'pending',
            submittedAt: new Date(),
        };

        if (isEdit) {
            kycData.lastEditedAt = new Date();
        }

        let kycDetails;
        if (existingKyc) {
            kycDetails = await KycDetails.findOneAndUpdate(
                { userId },
                { $set: kycData },
                { new: true }
            );
        } else {
            kycDetails = await KycDetails.create({ userId, ...kycData });
        }

        // Ensure secondary wallet exists alongside KYC
        await ensureSecondaryWallet(userId);

        res.json({
            success: true,
            message: isEdit
                ? 'KYC updated. Status reset to pending for re-verification.'
                : 'KYC submitted successfully. Payout Balance is now active.',
            kyc: {
                status: kycDetails.kycStatus,
                submittedAt: kycDetails.submittedAt,
                isEdit,
            },
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ error: 'KYC already exists for this user' });
        }
        console.error('❌ Error submitting KYC:', error);
        res.status(500).json({ error: 'Failed to submit KYC' });
    }
};

export const pinOtpStore = new Map();

/**
 * POST /wallets/pin/send-otp — Send 6-digit OTP code to email for setting/updating payment PIN
 */
export const sendPinOtp = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const user = await User.findById(userId).select('email contact userName').lean();
        const resolvedEmail = user?.email || (user?.contact && user.contact.includes('@') ? user.contact : null) || (req.body.email && req.body.email.includes('@') ? req.body.email.trim() : null);

        if (!user || !resolvedEmail) {
            return res.status(400).json({ error: 'Registered user email not found' });
        }

        // 30-second cooldown check
        const existing = pinOtpStore.get(userId);
        if (existing && existing.lastSentAt && (Date.now() - existing.lastSentAt < 30000)) {
            const waitSec = Math.ceil((30000 - (Date.now() - existing.lastSentAt)) / 1000);
            return res.status(429).json({
                error: `Please wait ${waitSec} seconds before requesting another OTP.`,
                retryAfterSec: waitSec
            });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        pinOtpStore.set(userId, {
            otp,
            expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
            lastSentAt: Date.now()
        });

        await sendOtpToEmail(resolvedEmail, otp, 'pin_setup');
        return res.json({
            success: true,
            message: `Payment PIN verification OTP code sent to ${resolvedEmail}. Valid for 5 minutes.`,
            email: resolvedEmail,
        });
    } catch (err) {
        console.error('Error sending PIN OTP:', err);
        return res.status(500).json({ error: 'Failed to send PIN OTP email' });
    }
};

/**
 * POST /wallets/pin/verify-otp — Verify 6-digit OTP code for PIN setup/update
 */
export const verifyPinOtp = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { otp } = req.body;
        if (!otp || String(otp).trim().length !== 6) {
            return res.status(400).json({ error: 'Valid 6-digit OTP code is required' });
        }

        const stored = pinOtpStore.get(userId);
        if (!stored || stored.expiresAt < Date.now()) {
            return res.status(400).json({ error: 'OTP has expired or is invalid. Please request a new OTP.' });
        }

        if (stored.otp !== String(otp).trim()) {
            return res.status(400).json({ error: 'Invalid OTP code. Please check your email.' });
        }

        // Grant 15-minute window for setting PIN
        pinOtpStore.set(`verified_${userId}`, Date.now() + 15 * 60 * 1000);
        pinOtpStore.delete(userId);

        return res.json({ success: true, message: 'OTP verified successfully! You can now set your 4-digit PIN.' });
    } catch (err) {
        console.error('Error verifying PIN OTP:', err);
        return res.status(500).json({ error: 'Failed to verify OTP' });
    }
};

/**
 * POST /wallets/pin/set — Set or Update 4-digit Payment PIN
 */
export const setPaymentPin = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        // Enforce OTP Verification check
        const verifiedUntil = pinOtpStore.get(`verified_${userId}`);
        if (!verifiedUntil || verifiedUntil < Date.now()) {
            return res.status(400).json({ error: 'Email OTP verification is required before setting payment PIN' });
        }

        const { pin, confirmPin } = req.body;
        if (!pin || !/^\d{4}$/.test(String(pin).trim())) {
            return res.status(400).json({ error: 'PIN must be a 4-digit numeric code' });
        }

        if (String(pin).trim() !== String(confirmPin).trim()) {
            return res.status(400).json({ error: 'PIN and confirmation PIN do not match' });
        }

        const primaryWallet = await ensurePrimaryWallet(userId);
        const pinHash = await bcrypt.hash(String(pin).trim(), 10);

        primaryWallet.pinHash = pinHash;
        primaryWallet.isPinSet = true;
        primaryWallet.isPinLocked = false;
        primaryWallet.failedPinAttempts = 0;
        await primaryWallet.save();

        pinOtpStore.delete(`verified_${userId}`);

        return res.json({
            success: true,
            message: 'Payment PIN set successfully!',
            isPinSet: true,
            isPinLocked: false,
        });
    } catch (err) {
        console.error('Error setting payment PIN:', err);
        return res.status(500).json({ error: 'Failed to set payment PIN' });
    }
};

/**
 * POST /wallets/purchase-ppv — Purchase PPV content using wallet balance
 */
export const purchasePpvWithWallet = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { contentId } = req.body;
        if (!contentId || !mongoose.Types.ObjectId.isValid(contentId)) {
            return res.status(400).json({ error: 'Valid content ID is required' });
        }

        // Fetch content and validate PPV
        const content = await Content.findById(contentId);
        if (!content) return res.status(404).json({ error: 'Content not found' });
        if (content.visibility !== 'pay_per_view') {
            return res.status(400).json({ error: 'This content is not Pay Per View' });
        }
        if (!content.price || content.price < 1) {
            return res.status(400).json({ error: 'Content price is not set' });
        }

        // Don't allow creator to purchase their own content
        if (content.userId.toString() === userId) {
            return res.status(400).json({ error: 'You cannot purchase your own content' });
        }

        // Check for existing active purchase
        const existingPurchase = await Purchase.findOne({
            contentId,
            buyerId: userId,
            status: 'active',
            expiresAt: { $gt: new Date() },
        });
        if (existingPurchase) {
            return res.status(400).json({ error: 'You already have an active purchase for this content', expiresAt: existingPurchase.expiresAt });
        }

        // ── PIN Verification Check ──
        const buyerWallet = await ensurePrimaryWallet(userId);
        if (!buyerWallet.isPinSet) {
            return res.status(400).json({
                error: 'Payment PIN is not set. Please set your PIN in Wallet page first.',
                isPinSet: false,
            });
        }

        if (buyerWallet.isPinLocked) {
            return res.status(400).json({
                error: 'Payment PIN is locked due to 3 incorrect attempts. Please update/reset your PIN in Wallet page.',
                isPinLocked: true,
            });
        }

        const { pin } = req.body;
        if (!pin || !/^\d{4}$/.test(String(pin).trim())) {
            return res.status(400).json({
                error: 'Please enter your 4-digit Payment PIN',
                pinRequired: true,
            });
        }

        const isPinValid = await bcrypt.compare(String(pin).trim(), buyerWallet.pinHash);
        if (!isPinValid) {
            buyerWallet.failedPinAttempts = (buyerWallet.failedPinAttempts || 0) + 1;
            if (buyerWallet.failedPinAttempts >= 3) {
                buyerWallet.isPinLocked = true;
                await buyerWallet.save();
                return res.status(400).json({
                    error: 'Incorrect PIN. Your Payment PIN has been locked due to 3 incorrect attempts. Please update your PIN in Wallet page.',
                    isPinLocked: true,
                    failedPinAttempts: 3,
                });
            }
            await buyerWallet.save();
            const remaining = 3 - buyerWallet.failedPinAttempts;
            return res.status(400).json({
                error: `Incorrect PIN. ${remaining} attempt(s) remaining.`,
                remainingAttempts: remaining,
                failedPinAttempts: buyerWallet.failedPinAttempts,
            });
        }

        // Reset failed PIN attempts on successful validation
        if (buyerWallet.failedPinAttempts > 0) {
            buyerWallet.failedPinAttempts = 0;
            await buyerWallet.save();
        }

        // Execute atomic wallet purchase (70% to creator, 30% platform)
        const result = await executePpvPurchase(userId, content.userId.toString(), contentId, content.price);

        // Trigger automated PPV rental email notification asynchronously
        sendPpvRentalEmail({
            userId,
            contentId,
            amount: content.price,
            orderId: result.purchase?.orderId || result.purchase?._id?.toString(),
            paymentMethod: 'Wallet Balance',
        }).catch(err => {
            console.error('[WalletPurchase] Failed to send PPV rental email:', err);
        });

        res.json({
            success: true,
            message: `Successfully purchased for ₹${content.price}`,
            purchase: {
                _id: result.purchase._id,
                contentId: result.purchase.contentId,
                amount: result.purchase.amount,
                expiresAt: result.purchase.expiresAt,
                status: result.purchase.status,
            },
            walletBalance: result.buyerTxn.balanceAfter,
            revenueBreakdown: {
                creatorEarning: result.creatorAmount,
                platformFee: result.platformAmount,
            },
        });
    } catch (error) {
        if (error.message === 'Insufficient wallet balance') {
            return res.status(400).json({ error: 'Insufficient wallet balance. Please recharge your wallet.' });
        }
        console.error('❌ Error purchasing PPV content:', error);
        res.status(500).json({ error: 'Failed to purchase content' });
    }
};
