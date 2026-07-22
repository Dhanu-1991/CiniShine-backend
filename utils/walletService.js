/**
 * Wallet Service — Core transactional wallet operations
 *
 * DESIGN INVARIANT: Every balance change is recorded as an immutable WalletTransaction
 * document. The cached wallet balance is only updated inside the same MongoDB session
 * that writes the ledger entry, so the two can never diverge.
 *
 * All multi-wallet operations (PPV purchase, transfer) use a single MongoDB session
 * so they are atomic: both sides succeed or both fail.
 *
 * REFACTORED: Uses PrimaryWallet + SecondaryWallet (separate models) instead of
 * the old single Wallet model with type discriminator.
 *
 * PPV REVENUE SPLIT: Creator receives 68% of the purchase price.
 * The remaining 32% is platform revenue (not stored in any wallet).
 */
import mongoose from 'mongoose';
import PrimaryWallet from '../models/primaryWallet.model.js';
import SecondaryWallet from '../models/secondaryWallet.model.js';
import WalletTransaction from '../models/walletTransaction.model.js';
import WalletTransferLog from '../models/walletTransferLog.model.js';
import Purchase from '../models/purchase.model.js';

/** Platform cut percentage for PPV purchases */
const PLATFORM_CUT_PERCENT = 32;

/**
 * Ensure a primary wallet exists for a user. Creates one if it doesn't exist.
 * Idempotent — safe to call multiple times.
 * @returns {PrimaryWallet} the primary wallet document
 */
export async function ensurePrimaryWallet(userId) {
    let wallet = await PrimaryWallet.findOne({ userId });
    if (!wallet) {
        try {
            wallet = await PrimaryWallet.create({
                userId,
                balance: 0,
                currency: 'INR',
            });
        } catch (err) {
            // Handle race condition: another request created it first
            if (err.code === 11000) {
                wallet = await PrimaryWallet.findOne({ userId });
            } else {
                throw err;
            }
        }
    }
    return wallet;
}

/**
 * Ensure a secondary wallet exists for a user. Creates one if it doesn't exist.
 * ONLY called during PPV credit or explicit KYC setup — never for recharge.
 */
export async function ensureSecondaryWallet(userId) {
    let wallet = await SecondaryWallet.findOne({ userId });
    if (!wallet) {
        try {
            wallet = await SecondaryWallet.create({
                userId,
                balance: 0,
                currency: 'INR',
            });
        } catch (err) {
            if (err.code === 11000) {
                wallet = await SecondaryWallet.findOne({ userId });
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
 * @param {string} walletType - 'primary' or 'secondary'
 * @param {number} amount - positive number to add
 * @param {string} type - transaction type enum value
 * @param {Object} meta - { relatedContentId, relatedPurchaseId, relatedOrderId, relatedBuyerId }
 * @param {string} idempotencyKey - unique key to prevent duplicate transactions
 * @param {ClientSession} session - MongoDB session for atomic operation
 * @returns {WalletTransaction} the created ledger entry
 */
export async function creditWallet(walletId, walletType, amount, type, meta, idempotencyKey, session) {
    if (amount <= 0) throw new Error('Credit amount must be positive');

    // Check idempotency — if this key already exists, return the existing transaction
    const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
    if (existing) return existing;

    // Resolve the right model
    const WalletModel = walletType === 'secondary' ? SecondaryWallet : PrimaryWallet;

    // Atomically increment balance and get the new value
    const wallet = await WalletModel.findOneAndUpdate(
        { _id: walletId },
        { $inc: { balance: amount } },
        { new: true, session }
    );
    if (!wallet) throw new Error(`Wallet ${walletId} not found`);

    // Write immutable ledger entry
    const [txn] = await WalletTransaction.create([{
        walletId,
        walletType,
        type,
        amount,
        balanceAfter: wallet.balance,
        relatedContentId: meta.relatedContentId || null,
        relatedPurchaseId: meta.relatedPurchaseId || null,
        relatedOrderId: meta.relatedOrderId || null,
        relatedBuyerId: meta.relatedBuyerId || null,
        status: 'completed',
        idempotencyKey,
    }], { session });

    return txn;
}

/**
 * Debit a wallet inside an existing session (atomic with ledger write).
 * Rejects if insufficient balance.
 */
export async function debitWallet(walletId, walletType, amount, type, meta, idempotencyKey, session) {
    if (amount <= 0) throw new Error('Debit amount must be positive');

    // Check idempotency
    const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
    if (existing) return existing;

    const WalletModel = walletType === 'secondary' ? SecondaryWallet : PrimaryWallet;

    // Atomically decrement balance, but only if sufficient funds
    const wallet = await WalletModel.findOneAndUpdate(
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
        walletType,
        type,
        amount,
        balanceAfter: wallet.balance,
        relatedContentId: meta.relatedContentId || null,
        relatedPurchaseId: meta.relatedPurchaseId || null,
        relatedOrderId: meta.relatedOrderId || null,
        relatedBuyerId: meta.relatedBuyerId || null,
        status: 'completed',
        idempotencyKey,
    }], { session });

    return txn;
}

/**
 * Execute a PPV purchase — single atomic transaction:
 * 1. Debit buyer's primary wallet (full price)
 * 2. Credit creator's secondary wallet (70% of price)
 * 3. Create Purchase record with 48h expiry
 *
 * The remaining 30% is platform revenue — not stored in any wallet.
 *
 * @param {string} buyerUserId
 * @param {string} creatorUserId
 * @param {string} contentId
 * @param {number} amount - price of the content
 * @returns {{ purchase, buyerTxn, creatorTxn, creatorAmount, platformAmount }}
 */
export async function executePpvPurchase(buyerUserId, creatorUserId, contentId, amount) {
    const creatorAmount = Number((amount * (100 - PLATFORM_CUT_PERCENT) / 100).toFixed(2));
    const platformAmount = Number((amount - creatorAmount).toFixed(2));

    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            // Find buyer's primary wallet
            const buyerWallet = await PrimaryWallet.findOne({ userId: buyerUserId }).session(session);
            if (!buyerWallet) throw new Error('Buyer wallet not found');
            if (buyerWallet.balance < amount) throw new Error('Insufficient wallet balance');

            // Find or create creator's secondary wallet
            let creatorWallet = await SecondaryWallet.findOne({ userId: creatorUserId }).session(session);
            if (!creatorWallet) {
                [creatorWallet] = await SecondaryWallet.create([{
                    userId: creatorUserId,
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

            // Debit buyer (full price)
            const buyerTxn = await debitWallet(
                buyerWallet._id, 'primary', amount, 'ppv_purchase_debit',
                {
                    relatedContentId: contentId,
                    relatedPurchaseId: purchase._id,
                    relatedOrderId: orderId,
                },
                `${purchaseIdempotencyKey}_debit`, session
            );

            // Credit creator (68% only)
            const creatorTxn = await creditWallet(
                creatorWallet._id, 'secondary', creatorAmount, 'ppv_earning_credit',
                {
                    relatedContentId: contentId,
                    relatedPurchaseId: purchase._id,
                    relatedOrderId: orderId,
                    relatedBuyerId: buyerUserId,
                },
                `${purchaseIdempotencyKey}_credit`, session
            );

            result = { purchase, buyerTxn, creatorTxn, creatorAmount, platformAmount };
        });
        return result;
    } finally {
        await session.endSession();
    }
}

/**
 * Transfer funds from secondary wallet to primary wallet (one-way, irreversible).
 * Single atomic transaction.
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

            const secondaryWallet = await SecondaryWallet.findOne({ userId }).session(session);
            if (!secondaryWallet) throw new Error('Secondary wallet not found');
            if (secondaryWallet.balance < amount) throw new Error('Insufficient secondary wallet balance');

            const primaryWallet = await PrimaryWallet.findOne({ userId }).session(session);
            if (!primaryWallet) throw new Error('Primary wallet not found');

            // Debit secondary
            const debitTxn = await debitWallet(
                secondaryWallet._id, 'secondary', amount, 'transfer_from_settlement',
                {}, `${idempotencyKey}_debit`, session
            );

            // Credit primary
            const creditTxn = await creditWallet(
                primaryWallet._id, 'primary', amount, 'transfer_to_primary',
                {}, `${idempotencyKey}_credit`, session
            );

            // Write transfer log
            const [transferLog] = await WalletTransferLog.create([{
                fromWalletId: secondaryWallet._id,
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
 * Credit a primary wallet for recharge (from Cashfree payment).
 * Uses a session for atomic balance + ledger update.
 *
 * GUARD: This function ONLY operates on PrimaryWallet. SecondaryWallet
 * cannot be recharged directly — it only receives PPV earning credits.
 */
export async function executeRecharge(userId, amount, orderId) {
    const session = await mongoose.startSession();
    try {
        let txn;
        await session.withTransaction(async () => {
            const wallet = await PrimaryWallet.findOneAndUpdate(
                { userId },
                { $inc: { balance: amount } },
                { new: true, session }
            );
            if (!wallet) throw new Error('Primary wallet not found');

            txn = await WalletTransaction.findOneAndUpdate(
                { relatedOrderId: orderId, type: 'recharge', status: 'pending' },
                { 
                    status: 'completed', 
                    balanceAfter: wallet.balance, 
                    idempotencyKey: `recharge_${orderId}` 
                },
                { new: true, session }
            );

            if (!txn) {
                [txn] = await WalletTransaction.create([{
                    walletId: wallet._id,
                    walletType: 'primary',
                    type: 'recharge',
                    amount,
                    balanceAfter: wallet.balance,
                    relatedOrderId: orderId,
                    status: 'completed',
                    idempotencyKey: `recharge_${orderId}`
                }], { session });
            }
        });
        return txn;
    } finally {
        await session.endSession();
    }
}

/**
 * Create a pending (initiation) transaction record.
 * This is created when user starts a recharge, before Cashfree confirms.
 * Auto-expires in 24 hours if never completed.
 * NOT counted as real money movement.
 */
export async function createPendingRechargeRecord(userId, amount, orderId) {
    const wallet = await PrimaryWallet.findOne({ userId });
    if (!wallet) return null;

    try {
        const [txn] = await WalletTransaction.create([{
            walletId: wallet._id,
            walletType: 'primary',
            type: 'recharge',
            amount,
            balanceAfter: wallet.balance, // Balance BEFORE — hasn't changed yet
            relatedOrderId: orderId,
            status: 'pending',
            idempotencyKey: `recharge_init_${orderId}`,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h TTL
        }]);
        return txn;
    } catch (err) {
        // Idempotency: if already exists, that's fine
        if (err.code === 11000) return null;
        throw err;
    }
}
