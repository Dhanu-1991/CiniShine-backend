import express from 'express';
import multer from 'multer';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';
import {
    getMyWallets,
    getWalletTransactions,
    rechargeInit,
    transferToWalletOne,
    sendTransferOtp,
    submitKyc,
    sendKycOtp,
    verifyKycOtp,
    purchasePpvWithWallet,
    sendPinOtp,
    verifyPinOtp,
    setPaymentPin,
} from '../../controllers/wallet-controllers/walletController.js';
import { handleRechargeWebhook } from '../../controllers/wallet-controllers/rechargeWebhookController.js';
import { runMonthEndPayout, getPayoutReport } from '../../controllers/wallet-controllers/payoutJobController.js';
import { getCreatorEarnings } from '../../controllers/wallet-controllers/earningsController.js';
import { getContentEarnings } from '../../controllers/wallet-controllers/contentEarningsController.js';

import { adminTokenVerifier } from '../../middlewares/admin.middleware.js';

const walletRouter = express.Router();

// Multer for KYC document upload (memory storage, max 15MB, images & PDF)
const kycUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
        cb(null, allowed.includes(file.mimetype));
    },
    limits: { fileSize: 15 * 1024 * 1024 },
});

// ── User & Creator wallet endpoints ──
walletRouter.get('/wallets', universalTokenVerifier, getMyWallets);
walletRouter.get('/wallets/earnings', universalTokenVerifier, getCreatorEarnings);
walletRouter.get('/wallets/earnings/:creatorId', universalTokenVerifier, getCreatorEarnings);
walletRouter.get('/wallets/content/:contentId/earnings', universalTokenVerifier, getContentEarnings);
walletRouter.get('/wallets/:walletId/transactions', universalTokenVerifier, getWalletTransactions);
walletRouter.post('/wallets/recharge', universalTokenVerifier, rechargeInit);
walletRouter.post('/wallets/transfer', universalTokenVerifier, transferToWalletOne);
walletRouter.post('/wallets/transfer/send-otp', universalTokenVerifier, sendTransferOtp);
walletRouter.post('/wallets/kyc/send-otp', universalTokenVerifier, sendKycOtp);
walletRouter.post('/wallets/kyc/verify-otp', universalTokenVerifier, verifyKycOtp);
walletRouter.post('/wallets/pin/send-otp', universalTokenVerifier, sendPinOtp);
walletRouter.post('/wallets/pin/verify-otp', universalTokenVerifier, verifyPinOtp);
walletRouter.post('/wallets/pin/set', universalTokenVerifier, setPaymentPin);
walletRouter.post('/wallets/kyc', universalTokenVerifier, kycUpload.fields([
    { name: 'kycDocument', maxCount: 1 },
    { name: 'gstCertificate', maxCount: 1 }
]), submitKyc);
walletRouter.post('/wallets/purchase-ppv', universalTokenVerifier, purchasePpvWithWallet);

// ── Cashfree recharge webhook (no auth, signature-verified) ──
walletRouter.post('/wallets/recharge-webhook', express.raw({ type: 'application/json' }), handleRechargeWebhook);

// ── Admin endpoints (protected by admin auth) ──
walletRouter.post('/admin/payouts/run', adminTokenVerifier, runMonthEndPayout);
walletRouter.get('/admin/payouts/:month', adminTokenVerifier, getPayoutReport);

export default walletRouter;
