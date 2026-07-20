/**
 * Wallet Service — Core transactional wallet operations
 *
 * DESIGN INVARIANT: Every balance change is recorded as an immutable WalletTransaction
 * document. The cached Wallet.balance is only updated inside the same MongoDB session
 * that writes the ledger entry, so the two can never diverge.
 *
 * All multi-wallet operations (PPV purchase, transfer) use a single MongoDB session
 * so they are atomic: both sides succeed or both fail.
 */
import mongoose from 'mongoose';
import Wallet from '../models/wallet.model.js';
import WalletTransaction from '../models/walletTransaction.model.js';
import WalletTransferLog from '../models/walletTransferLog.model.js';
import Purchase from '../models/purchase.model.js';

/**
 * Ensure a primary wallet exists for a user. Creates one if it doesn't exist.
 * Idempotent — safe to call multiple times.
 * @returns {Wallet} the primary wallet document
 */
export async function ensurePrimaryWallet(userId) {
    let wallet = await Wallet.findOne({ userId, type: 'primary' });
    if (!wallet) {
        try {
            wallet = await Wallet.create({
                userId,
                type: 'primary',
                balance: 0,
                currency: 'INR',
            });
        } catch (err) {
            // Handle race condition: another request created it first
            if (err.code === 11000) {
                wallet = await Wallet.findOne({ userId, type: 'primary' });
            } else {
                throw err;
            }
        }
    }
    return wallet;
}

/**
 * Credit a wallet inside an existing session (atomic with ledger write).
 * @param {ObjectId} walletId
 * @param {number} amount - positive number to add
 * @param {string} type - transaction type enum value
 * @param {Object} meta - { relatedContentId, relatedPurchaseId, relatedOrderId }
 * @param {string} idempotencyKey - unique key to prevent duplicate transactions
 * @param {ClientSession} session - MongoDB session for atomic operation
 * @returns {WalletTransaction} the created ledger entry
 */
export async function creditWallet(walletId, amount, type, meta, idempotencyKey, session) {
    if (amount <= 0) throw new Error('Credit amount must be positive');

    // Check idempotency — if this key already exists, return the existing transaction
    const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
    if (existing) return existing;

    // Atomically increment balance and get the new value
    const wallet = await Wallet.findOneAndUpdate(
        { _id: walletId },
        { $inc: { balance: amount } },
        { new: true, session }
    );
    if (!wallet) throw new Error(`Wallet ${walletId} not found`);

    // Write immutable ledger entry
    const [txn] = await WalletTransaction.create([{
        walletId,
        type,
        amount,
        balanceAfter: wallet.balance,
        relatedContentId: meta.relatedContentId || null,
        relatedPurchaseId: meta.relatedPurchaseId || null,
        relatedOrderId: meta.relatedOrderId || null,
        status: 'completed',
        idempotencyKey,
    }], { session });

    return txn;
}

/**
 * Debit a wallet inside an existing session (atomic with ledger write).
 * Rejects if insufficient balance.
 */
export async function debitWallet(walletId, amount, type, meta, idempotencyKey, session) {
    if (amount <= 0) throw new Error('Debit amount must be positive');

    // Check idempotency
    const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
    if (existing) return existing;

    // Atomically decrement balance, but only if sufficient funds
    const wallet = await Wallet.findOneAndUpdate(
        { _id: walletId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true, session }
    );
    if (!wallet) {
        throw new Error('Insufficient wallet balance');
    }

    // Write immutable ledger entry
    const [txn] = await WalletTransaction.create([{
        walletId,
        type,
        amount,
        balanceAfter: wallet.balance,
        relatedContentId: meta.relatedContentId || null,
        relatedPurchaseId: meta.relatedPurchaseId || null,
        relatedOrderId: meta.relatedOrderId || null,
        status: 'completed',
        idempotencyKey,
    }], { session });

    return txn;
}

/**
 * Execute a PPV purchase — single atomic transaction:
 * 1. Debit buyer's primary wallet
 * 2. Credit creator's settlement wallet (if exists) or primary wallet
 * 3. Create Purchase record with 48h expiry
 *
 * @param {string} buyerUserId
 * @param {string} creatorUserId
 * @param {string} contentId
 * @param {number} amount - price of the content
 * @returns {{ purchase: Purchase, buyerTxn: WalletTransaction, creatorTxn: WalletTransaction }}
 */
export async function executePpvPurchase(buyerUserId, creatorUserId, contentId, amount) {
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            // Find buyer's primary wallet
            const buyerWallet = await Wallet.findOne({ userId: buyerUserId, type: 'primary' }).session(session);
            if (!buyerWallet) throw new Error('Buyer wallet not found');
            if (buyerWallet.balance < amount) throw new Error('Insufficient wallet balance');

            // Find creator's wallet — prefer settlement, fall back to primary
            let creatorWallet = await Wallet.findOne({ userId: creatorUserId, type: 'settlement', kycStatus: 'submitted' }).session(session);
            if (!creatorWallet) {
                creatorWallet = await Wallet.findOne({ userId: creatorUserId, type: 'primary' }).session(session);
            }
            if (!creatorWallet) {
                // Auto-create primary wallet for creator if missing
                [creatorWallet] = await Wallet.create([{
                    userId: creatorUserId,
                    type: 'primary',
                    balance: 0,
                    currency: 'INR',
                }], { session });
            }

            // Generate unique order ID
            const orderId = `WALLET_PPV_${Date.now()}_${buyerUserId.toString().slice(-6)}`;
            const purchaseIdempotencyKey = `ppv_purchase_${contentId}_${buyerUserId}_${orderId}`;

            // Create Purchase record
            const [purchase] = await Purchase.create([{
                contentId,
                buyerId: buyerUserId,
                orderId,
                paymentId: `wallet_${orderId}`,
                amount,
                currency: 'INR',
                status: 'active',
                expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours
            }], { session });

            // Debit buyer
            const buyerTxn = await debitWallet(
                buyerWallet._id, amount, 'ppv_purchase_debit',
                { relatedContentId: contentId, relatedPurchaseId: purchase._id, relatedOrderId: orderId },
                `${purchaseIdempotencyKey}_debit`, session
            );

            // Credit creator
            const creatorTxn = await creditWallet(
                creatorWallet._id, amount, 'ppv_earning_credit',
                { relatedContentId: contentId, relatedPurchaseId: purchase._id, relatedOrderId: orderId },
                `${purchaseIdempotencyKey}_credit`, session
            );

            result = { purchase, buyerTxn, creatorTxn };
        });
        return result;
    } finally {
        await session.endSession();
    }
}

/**
 * Transfer funds from settlement wallet to primary wallet (one-way, irreversible).
 * Single atomic transaction.
 *
 * @param {string} userId
 * @param {number} amount
 * @param {string} idempotencyKey
 * @returns {{ debitTxn, creditTxn, transferLog }}
 */
export async function executeTransfer(userId, amount, idempotencyKey) {
    if (amount <= 0) throw new Error('Transfer amount must be positive');

    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            // Check idempotency on transfer log
            const existingLog = await WalletTransferLog.findOne({ idempotencyKey }).session(session);
            if (existingLog) {
                result = { transferLog: existingLog, alreadyProcessed: true };
                return;
            }

            const settlementWallet = await Wallet.findOne({ userId, type: 'settlement' }).session(session);
            if (!settlementWallet) throw new Error('Settlement wallet not found');
            if (settlementWallet.balance < amount) throw new Error('Insufficient settlement wallet balance');

            const primaryWallet = await Wallet.findOne({ userId, type: 'primary' }).session(session);
            if (!primaryWallet) throw new Error('Primary wallet not found');

            // Debit settlement
            const debitTxn = await debitWallet(
                settlementWallet._id, amount, 'transfer_from_settlement',
                {}, `${idempotencyKey}_debit`, session
            );

            // Credit primary
            const creditTxn = await creditWallet(
                primaryWallet._id, amount, 'transfer_to_primary',
                {}, `${idempotencyKey}_credit`, session
            );

            // Write transfer log
            const [transferLog] = await WalletTransferLog.create([{
                fromWalletId: settlementWallet._id,
                toWalletId: primaryWallet._id,
                amount,
                direction: 'settlement_to_primary',
                reversible: false,
                idempotencyKey,
            }], { session });

            result = { debitTxn, creditTxn, transferLog };
        });
        return result;
    } finally {
        await session.endSession();
    }
}

/**
 * Credit a wallet for recharge (from Cashfree payment).
 * Uses a session for atomic balance + ledger update.
 *
 * @param {string} userId
 * @param {number} amount
 * @param {string} orderId - Cashfree order ID (used as part of idempotency key)
 * @returns {WalletTransaction}
 */
export async function executeRecharge(userId, amount, orderId) {
    const session = await mongoose.startSession();
    try {
        let txn;
        await session.withTransaction(async () => {
            const wallet = await Wallet.findOne({ userId, type: 'primary' }).session(session);
            if (!wallet) throw new Error('Primary wallet not found');

            txn = await creditWallet(
                wallet._id, amount, 'recharge',
                { relatedOrderId: orderId },
                `recharge_${orderId}`, session
            );
        });
        return txn;
    } finally {
        await session.endSession();
    }
}
