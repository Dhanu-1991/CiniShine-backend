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
import User from '../../models/user.model.js';
import { sendOtpToEmail } from '../auth-controllers/services/otpServiceEmail.js';
import { calculateTaxBreakdown } from '../../utils/taxCalculator.js';
import PaymentDetails from '../../models/payment.details.model.js';
import { Cashfree, CFEnvironment } from 'cashfree-pg';
import Razorpay from 'razorpay';
import crypto from 'crypto';

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

/**
 * GET /wallets — Get user's wallets (primary + secondary if exists)
 */
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
                label: 'Settlement Wallet',
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
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;

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
                        const approxSelling = Math.round(txn.amount / 0.612985);
                        txn.taxBreakdown = calculateTaxBreakdown(approxSelling);
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

/**
 * POST /wallets/transfer — Transfer from secondary to primary wallet
 */
export const transferToWalletOne = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { amount, confirmTransfer } = req.body;
        const numAmount = Number(amount);

        console.log(`[WALLET_TRANSFER_HTTP_REQ] User: ${userId} | Amount: ₹${numAmount} | Confirm: ${confirmTransfer}`);

        if (!numAmount || numAmount <= 0) {
            return res.status(400).json({ error: 'Transfer amount must be positive' });
        }

        // Require explicit confirmation
        if (confirmTransfer !== true) {
            return res.status(400).json({
                error: 'Transfer requires explicit confirmation',
                warning: 'This transfer is irreversible. Funds moved to Wallet One become non-withdrawable in-app credit and cannot be transferred back or paid out to a bank account.',
                requiresConfirmation: true,
            });
        }

        const idempotencyKey = `transfer_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        const result = await executeTransfer(userId, numAmount, idempotencyKey);

        if (result.alreadyProcessed) {
            return res.json({ success: true, message: 'Transfer already processed', alreadyProcessed: true });
        }

        res.json({
            success: true,
            message: `₹${numAmount} transferred to Wallet One`,
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

const kycOtpStore = new Map();

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

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        kycOtpStore.set(userId, {
            otp,
            expiresAt: Date.now() + 10 * 60 * 1000,
        });

        await sendOtpToEmail(resolvedEmail, otp);
        return res.json({
            success: true,
            message: `Verification OTP code sent to ${resolvedEmail}`,
            email: resolvedEmail,
        });
    } catch (err) {
        console.error('Error sending KYC OTP:', err);
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

        // Grant 15-minute window for KYC submission
        kycOtpStore.set(`verified_${userId}`, Date.now() + 15 * 60 * 1000);
        kycOtpStore.delete(userId);

        return res.json({ success: true, message: 'OTP verified successfully!' });
    } catch (err) {
        console.error('Error verifying KYC OTP:', err);
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
                : 'KYC submitted successfully. Settlement wallet is now active.',
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

        // Execute atomic wallet purchase (70% to creator, 30% platform)
        const result = await executePpvPurchase(userId, content.userId.toString(), contentId, content.price);

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
