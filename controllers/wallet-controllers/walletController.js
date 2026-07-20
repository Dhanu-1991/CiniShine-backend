/**
 * Wallet Controller
 *
 * Endpoints:
 * - GET  /wallets                     — Get user's wallets (primary + settlement if exists)
 * - GET  /wallets/:walletId/transactions — Paginated transaction history
 * - POST /wallets/recharge            — Initiate wallet recharge via Cashfree
 * - POST /wallets/transfer            — Transfer from settlement to primary wallet
 * - POST /wallets/kyc                 — Submit KYC and create settlement wallet
 * - POST /wallets/purchase-ppv        — Purchase PPV content using wallet balance
 */
import mongoose from 'mongoose';
import Wallet from '../../models/wallet.model.js';
import WalletTransaction from '../../models/walletTransaction.model.js';
import { ensurePrimaryWallet, executePpvPurchase, executeTransfer, executeRecharge } from '../../utils/walletService.js';
import { encryptBankDetails, decryptBankDetails } from '../../utils/encryption.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import Content from '../../models/content.model.js';
import { Cashfree } from 'cashfree-pg';
import crypto from 'crypto';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * GET /wallets — Returns both wallets for the authenticated user
 */
export const getMyWallets = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        // Ensure primary wallet exists (lazy creation for existing users)
        const primaryWallet = await ensurePrimaryWallet(userId);
        const settlementWallet = await Wallet.findOne({ userId, type: 'settlement' });

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

        if (settlementWallet) {
            wallets.settlement = {
                _id: settlementWallet._id,
                type: 'settlement',
                balance: settlementWallet.balance,
                currency: settlementWallet.currency,
                kycStatus: settlementWallet.kycStatus,
                label: 'Settlement Wallet',
                withdrawable: true,
                note: 'Paid out automatically at month-end to your bank account, minus 1% maintenance fee.',
            };
        } else {
            wallets.settlement = null;
            wallets.kycRequired = true;
        }

        res.json({ wallets });
    } catch (error) {
        console.error('❌ Error fetching wallets:', error);
        res.status(500).json({ error: 'Failed to fetch wallets' });
    }
};

/**
 * GET /wallets/:walletId/transactions — Paginated transaction history
 */
export const getWalletTransactions = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { walletId } = req.params;
        const { page = 1, limit = 20 } = req.query;

        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        // Verify wallet ownership
        const wallet = await Wallet.findById(walletId);
        if (!wallet || wallet.userId.toString() !== userId) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [transactions, total] = await Promise.all([
            WalletTransaction.find({ walletId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .populate('relatedContentId', 'title contentType thumbnailKey')
                .lean(),
            WalletTransaction.countDocuments({ walletId }),
        ]);

        res.json({
            transactions: transactions.map(t => ({
                _id: t._id,
                type: t.type,
                amount: t.amount,
                balanceAfter: t.balanceAfter,
                status: t.status,
                contentTitle: t.relatedContentId?.title || null,
                contentType: t.relatedContentId?.contentType || null,
                relatedOrderId: t.relatedOrderId,
                createdAt: t.createdAt,
            })),
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
            },
        });
    } catch (error) {
        console.error('❌ Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
};

/**
 * POST /wallets/recharge — Initiate Cashfree recharge order (min ₹19)
 */
export const rechargeInit = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { amount } = req.body;
        const numAmount = Number(amount);

        // Server-side minimum enforcement
        if (!numAmount || numAmount < 19) {
            return res.status(400).json({ error: 'Minimum recharge amount is ₹19' });
        }

        // Ensure primary wallet exists
        await ensurePrimaryWallet(userId);

        // Import User model to get customer details
        const User = mongoose.model('User');
        const user = await User.findById(userId).select('contact userName fullName');
        if (!user) return res.status(404).json({ error: 'User not found' });

        const orderId = `RECHARGE_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

        const cfEnv = process.env.CASHFREE_MODE === 'production' ? 'PRODUCTION' : 'SANDBOX';
        const cashfree = new Cashfree(cfEnv, process.env.CF_CLIENT_ID, process.env.CF_CLIENT_SECRET);

        const orderRequest = {
            order_id: orderId,
            order_amount: numAmount,
            order_currency: 'INR',
            customer_details: {
                customer_id: userId,
                customer_email: user.contact || `${userId}@noemail.com`,
                customer_phone: '9999999999',
                customer_name: user.fullName || user.userName || 'User',
            },
            order_meta: {
                return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/wallet?order_id={order_id}`,
            },
            order_tags: {
                type: 'wallet_recharge',
                userId: userId.toString(),
            },
        };

        const response = await cashfree.PGCreateOrder(orderRequest);

        res.json({
            success: true,
            orderId,
            paymentSessionId: response.data?.payment_session_id,
            orderAmount: numAmount,
        });
    } catch (error) {
        console.error('❌ Error creating recharge order:', error);
        res.status(500).json({ error: 'Failed to create recharge order' });
    }
};

/**
 * POST /wallets/transfer — Transfer from settlement to primary wallet
 */
export const transferToWalletOne = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { amount, confirmTransfer } = req.body;
        const numAmount = Number(amount);

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
        if (error.message === 'Insufficient settlement wallet balance') {
            return res.status(400).json({ error: 'Insufficient settlement wallet balance' });
        }
        console.error('❌ Error transferring funds:', error);
        res.status(500).json({ error: 'Failed to transfer funds' });
    }
};

/**
 * POST /wallets/kyc — Submit KYC details and create settlement wallet immediately
 */
export const submitKyc = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { bankAccountNumber, bankName, ifscCode, accountHolderName, kycDocumentType } = req.body;

        // Validate required fields
        if (!bankAccountNumber || !bankName || !ifscCode || !accountHolderName) {
            return res.status(400).json({ error: 'All bank details are required: account number, bank name, IFSC, account holder name' });
        }
        if (!kycDocumentType || !['passbook', 'cancelled_cheque'].includes(kycDocumentType)) {
            return res.status(400).json({ error: 'Document type must be "passbook" or "cancelled_cheque"' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'KYC document (passbook or cancelled cheque image) is required' });
        }

        // Check if settlement wallet already exists
        const existing = await Wallet.findOne({ userId, type: 'settlement' });
        if (existing && existing.kycStatus === 'submitted') {
            return res.status(400).json({ error: 'KYC already submitted. Settlement wallet is active.' });
        }

        // Upload document to private KYC bucket with encryption at rest
        const fileExtension = req.file.originalname?.split('.').pop()?.toLowerCase() || 'jpg';
        const kycDocumentKey = `kyc-documents/${userId}/${uuidv4()}.${fileExtension}`;

        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.S3_KYC_BUCKET || process.env.S3_BUCKET,
            Key: kycDocumentKey,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            ServerSideEncryption: 'AES256',
        }));

        // Encrypt bank details
        const encryptedFields = encryptBankDetails({ bankAccountNumber, bankName, ifscCode, accountHolderName });

        // Create or update settlement wallet
        const wallet = existing
            ? await Wallet.findOneAndUpdate(
                { _id: existing._id },
                { ...encryptedFields, kycDocumentKey, kycDocumentType, kycStatus: 'submitted' },
                { new: true }
            )
            : await Wallet.create({
                userId,
                type: 'settlement',
                balance: 0,
                currency: 'INR',
                kycStatus: 'submitted',
                kycDocumentKey,
                kycDocumentType,
                ...encryptedFields,
            });

        res.json({
            success: true,
            message: 'KYC submitted successfully. Settlement wallet is now active.',
            wallet: {
                _id: wallet._id,
                type: 'settlement',
                balance: wallet.balance,
                kycStatus: wallet.kycStatus,
            },
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ error: 'Settlement wallet already exists' });
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
        const existingPurchase = await mongoose.model('Purchase').findOne({
            contentId,
            buyerId: userId,
            status: 'active',
            expiresAt: { $gt: new Date() },
        });
        if (existingPurchase) {
            return res.status(400).json({ error: 'You already have an active purchase for this content', expiresAt: existingPurchase.expiresAt });
        }

        // Execute atomic wallet purchase
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
        });
    } catch (error) {
        if (error.message === 'Insufficient wallet balance') {
            return res.status(400).json({ error: 'Insufficient wallet balance. Please recharge your wallet.' });
        }
        console.error('❌ Error purchasing PPV content:', error);
        res.status(500).json({ error: 'Failed to purchase content' });
    }
};
