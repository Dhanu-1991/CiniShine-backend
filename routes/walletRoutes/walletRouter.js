import express from 'express';
import multer from 'multer';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';
import {
    getMyWallets,
    getWalletTransactions,
    rechargeInit,
    transferToWalletOne,
    submitKyc,
    purchasePpvWithWallet,
} from '../../controllers/wallet-controllers/walletController.js';
import { handleRechargeWebhook } from '../../controllers/wallet-controllers/rechargeWebhookController.js';
import { runMonthEndPayout, getPayoutReport } from '../../controllers/wallet-controllers/payoutJobController.js';

import { adminTokenVerifier } from '../../middlewares/admin.middleware.js';

const walletRouter = express.Router();

// Multer for KYC document upload (memory storage, max 5MB, images only)
const kycUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        cb(null, allowed.includes(file.mimetype));
    },
    limits: { fileSize: 5 * 1024 * 1024 },
});

// ── User wallet endpoints ──
walletRouter.get('/wallets', universalTokenVerifier, getMyWallets);
walletRouter.get('/wallets/:walletId/transactions', universalTokenVerifier, getWalletTransactions);
walletRouter.post('/wallets/recharge', universalTokenVerifier, rechargeInit);
walletRouter.post('/wallets/transfer', universalTokenVerifier, transferToWalletOne);
walletRouter.post('/wallets/kyc', universalTokenVerifier, kycUpload.single('kycDocument'), submitKyc);
walletRouter.post('/wallets/purchase-ppv', universalTokenVerifier, purchasePpvWithWallet);

// ── Cashfree recharge webhook (no auth, signature-verified) ──
walletRouter.post('/wallets/recharge-webhook', express.raw({ type: 'application/json' }), handleRechargeWebhook);

// ── Admin endpoints (protected by admin auth) ──
walletRouter.post('/admin/payouts/run', adminTokenVerifier, runMonthEndPayout);
walletRouter.get('/admin/payouts/:month', adminTokenVerifier, getPayoutReport);

export default walletRouter;
