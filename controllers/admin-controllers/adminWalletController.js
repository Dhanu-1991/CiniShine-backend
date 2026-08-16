import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import mongoose from 'mongoose';
import KycDetails from '../../models/kycDetails.model.js';
import PrimaryWallet from '../../models/primaryWallet.model.js';
import SecondaryWallet from '../../models/secondaryWallet.model.js';
import { decryptBankDetails } from '../../utils/encryption.js';
import { sendAdminEmail } from '../../services/adminEmailService.js';
import { getCfUrl } from '../../config/cloudfront.js';
import User from '../../models/user.model.js';
import { creditWallet, debitWallet, ensurePrimaryWallet, ensureSecondaryWallet } from '../../utils/walletService.js';

// Setup S3 Client using env vars
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

export const getKycList = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const status = req.query.status;

        const query = {};
        if (status && status !== 'all') {
            if (status === 'gst_applicants' || status === 'gst_holders') {
                query.isGstHolder = true;
            } else {
                query.kycStatus = status;
            }
        }

        const kycList = await KycDetails.find(query)
            .populate('userId', 'userName channelName contact')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit);
        
        const total = await KycDetails.countDocuments(query);

        // Map and format response
        const formattedKycList = await Promise.all(kycList.map(async (kyc) => {
            let decryptedBank = null;
            if (kyc.bankAccountNumberEncrypted) {
                decryptedBank = decryptBankDetails(kyc);
            }

            let presignedUrl = null;
            if (kyc.kycDocumentKey) {
                presignedUrl = getCfUrl(kyc.kycDocumentKey);
            }

            let gstCertUrl = null;
            if (kyc.gstCertificateKey) {
                gstCertUrl = getCfUrl(kyc.gstCertificateKey);
            }

            return {
                _id: kyc._id,
                user: kyc.userId,
                bankDetails: decryptedBank,
                kycDocumentUrl: presignedUrl,
                kycDocumentType: kyc.kycDocumentType,
                isGstHolder: kyc.isGstHolder || false,
                gstNumber: kyc.gstNumber || null,
                gstCertificateUrl: gstCertUrl,
                kycStatus: kyc.kycStatus,
                submittedAt: kyc.submittedAt,
                createdAt: kyc.createdAt
            };
        }));

        res.status(200).json({
            success: true,
            kycList: formattedKycList,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching KYC list:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const getWalletsList = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search?.trim();
        const sort = req.query.sort || 'balance_desc';
        const sortObj = {
            'balance_desc': { balance: -1 },
            'balance_asc': { balance: 1 },
            'created_desc': { createdAt: -1 },
            'created_asc': { createdAt: 1 },
        }[sort] || { balance: -1 };

        let query = {};
        if (search) {
            const User = mongoose.model('User');
            const users = await User.find({
                $or: [
                    { userName: new RegExp(search, 'i') },
                    { contact: new RegExp(search, 'i') },
                    { channelName: new RegExp(search, 'i') }
                ]
            }).select('_id');
            const userIds = users.map(u => u._id);
            query = { userId: { $in: userIds } };
        }

        const wallets = await PrimaryWallet.find(query)
            .populate('userId', 'userName channelName contact')
            .sort(sortObj)
            .skip((page - 1) * limit)
            .limit(limit);
        
        const total = await PrimaryWallet.countDocuments(query);
        const totalBalanceResult = await PrimaryWallet.aggregate([
            { $match: query },
            { $group: { _id: null, totalBalance: { $sum: '$balance' } } }
        ]);
        const totalBalance = totalBalanceResult[0]?.totalBalance || 0;

        res.status(200).json({
            success: true,
            wallets,
            totalBalance,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching primary wallets:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const getSecondaryWalletsList = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search?.trim();
        const sort = req.query.sort || 'balance_desc';
        const sortObj = {
            'balance_desc': { balance: -1 },
            'balance_asc': { balance: 1 },
            'created_desc': { createdAt: -1 },
            'created_asc': { createdAt: 1 },
        }[sort] || { balance: -1 };

        let query = {};
        if (search) {
            const User = mongoose.model('User');
            const users = await User.find({
                $or: [
                    { userName: new RegExp(search, 'i') },
                    { contact: new RegExp(search, 'i') },
                    { channelName: new RegExp(search, 'i') }
                ]
            }).select('_id');
            const userIds = users.map(u => u._id);
            query = { userId: { $in: userIds } };
        }

        const wallets = await SecondaryWallet.find(query)
            .populate('userId', 'userName channelName contact')
            .sort(sortObj)
            .skip((page - 1) * limit)
            .limit(limit);
        
        const total = await SecondaryWallet.countDocuments(query);
        const totalBalanceResult = await SecondaryWallet.aggregate([
            { $match: query },
            { $group: { _id: null, totalBalance: { $sum: '$balance' } } }
        ]);
        const totalBalance = totalBalanceResult[0]?.totalBalance || 0;

        res.status(200).json({
            success: true,
            wallets,
            totalBalance,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching secondary wallets:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const verifyKyc = async (req, res) => {
    try {
        const { kycId } = req.params;
        const kyc = await KycDetails.findById(kycId).populate('userId', 'userName contact email');
        if (!kyc) {
            return res.status(404).json({ success: false, message: 'KYC not found' });
        }

        kyc.kycStatus = 'verified';
        await kyc.save();

        if (kyc.userId) {
            await sendAdminEmail('kycApproved', kyc.userId.contact || kyc.userId.email, {
                creatorName: kyc.userId.userName || 'Creator',
                adminName: req.admin?.name || 'Admin',
            });
        }

        res.status(200).json({ success: true, message: 'KYC verified successfully' });
    } catch (error) {
        console.error('Error verifying KYC:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const rejectKyc = async (req, res) => {
    try {
        const { kycId } = req.params;
        const { rejectionReason } = req.body;
        
        if (!rejectionReason) {
            return res.status(400).json({ success: false, message: 'Rejection reason is required' });
        }

        const kyc = await KycDetails.findById(kycId).populate('userId', 'userName contact email');
        if (!kyc) {
            return res.status(404).json({ success: false, message: 'KYC not found' });
        }

        kyc.kycStatus = 'rejected';
        kyc.rejectionReason = rejectionReason;
        await kyc.save();

        if (kyc.userId) {
            await sendAdminEmail('kycRejected', kyc.userId.contact || kyc.userId.email, {
                creatorName: kyc.userId.userName || 'Creator',
                rejectionReason,
                adminName: req.admin?.name || 'Admin',
            });
        }

        res.status(200).json({ success: true, message: 'KYC rejected successfully' });
    } catch (error) {
        console.error('Error rejecting KYC:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const adminCreditDebitWallet = async (req, res) => {
    try {
        const { userId, walletType, action, amount, reason } = req.body;
        
        if (!userId || !walletType || !action || !amount || !reason) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        if (amount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
        }
        if (!['credit', 'debit'].includes(action)) {
            return res.status(400).json({ success: false, message: 'Action must be credit or debit' });
        }
        if (!['primary', 'secondary'].includes(walletType)) {
            return res.status(400).json({ success: false, message: 'Wallet type must be primary or secondary' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const idempotencyKey = `admin_${action}_${userId}_${Date.now()}`;
        const transactionType = action === 'credit' ? 'admin_credit' : 'admin_debit';
        let txn = null;

        if (walletType === 'primary') {
            const wallet = await ensurePrimaryWallet(userId);

            // ── Balance guard for debit ──────────────────────────────────────
            if (action === 'debit') {
                if (wallet.balance < amount) {
                    return res.status(400).json({
                        success: false,
                        message: `Insufficient balance. Current Wallet balance is ₹${wallet.balance.toFixed(2)}, but you are trying to debit ₹${Number(amount).toFixed(2)}.`
                    });
                }
                txn = await debitWallet(wallet._id, 'primary', amount, transactionType, { reason }, idempotencyKey);
            } else {
                txn = await creditWallet(wallet._id, 'primary', amount, transactionType, { reason }, idempotencyKey);
            }
        } else {
            const wallet = await ensureSecondaryWallet(userId);

            // ── Balance guard for debit ──────────────────────────────────────
            if (action === 'debit') {
                if (wallet.balance < amount) {
                    return res.status(400).json({
                        success: false,
                        message: `Insufficient balance. Current Payout Balance is ₹${wallet.balance.toFixed(2)}, but you are trying to debit ₹${Number(amount).toFixed(2)}.`
                    });
                }
                txn = await debitWallet(wallet._id, 'secondary', amount, transactionType, { reason }, idempotencyKey);
            } else {
                txn = await creditWallet(wallet._id, 'secondary', amount, transactionType, { reason }, idempotencyKey);
            }
        }

        const creatorName = user.channelName || user.userName || 'Creator';
        const contact = user.contact || user.email;

        if (contact && contact.includes('@')) {
            sendAdminEmail('walletAdjusted', contact, {
                creatorName,
                action,
                amount,
                walletType: walletType === 'primary' ? 'Wallet' : 'Payout Balance',
                reason,
                adminId: req.admin?._id,
                adminEmail: req.admin?.email || req.admin?.name || 'Super Admin',
                userId: user._id,
            }).catch(err => console.error('[ADMIN_WALLET] Failed to send email:', err.message));
        }

        res.status(200).json({ success: true, message: `Wallet ${action}ed successfully`, transaction: txn });
    } catch (error) {
        console.error('[ADMIN_CREDIT_DEBIT_WALLET]', error);
        // Return 400 for known business-logic errors, 500 for unexpected ones
        const isBusinessError = error.message?.includes('Insufficient') || error.message?.includes('balance');
        res.status(isBusinessError ? 400 : 500).json({ success: false, message: error.message || 'Server error' });
    }
};

