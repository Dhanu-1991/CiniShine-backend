import mongoose from 'mongoose';

/**
 * WalletTransaction — Immutable ledger of all wallet balance changes.
 *
 * DESIGN:
 * - `status: 'completed'` = confirmed money movement (only these count as history)
 * - `status: 'pending'`   = payment initiated but not confirmed by gateway
 * - `status: 'failed'`    = gateway-confirmed failure
 * - `status: 'abandoned'` = pending record that timed out (auto-pruned by TTL)
 *
 * Pending records auto-expire after 24 hours via TTL index.
 * Only 'completed' records are shown in user-facing transaction history.
 *
 * PRIVACY (secondary wallet):
 * The `relatedBuyerId` field stores who purchased PPV content.
 * When a creator views their secondary wallet activity, the API response
 * must NEVER include `relatedBuyerId` — this is enforced at the API layer,
 * not by omitting the field from the model (we need it for reconciliation).
 */
const walletTransactionSchema = new mongoose.Schema({
    walletId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true,
    },
    walletType: {
        type: String,
        enum: ['primary', 'secondary'],
        required: true,
        index: true,
    },
    type: {
        type: String,
        enum: [
            'recharge',              // Primary: Cashfree recharge credit
            'ppv_purchase_debit',    // Primary: buyer pays for PPV content
            'ppv_earning_credit',    // Secondary: creator receives 70% cut
            'payout',                // Secondary: month-end payout debit
            'payout_fee',            // Secondary: 1% maintenance fee debit
            'transfer_to_primary',   // Primary: credit from settlement transfer
            'transfer_from_settlement', // Secondary: debit for transfer
            'adjustment',            // Manual adjustment (admin)
        ],
        required: true,
    },
    amount: { type: Number, required: true },  // always positive
    balanceAfter: { type: Number, required: true },
    relatedContentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', default: null },
    relatedPurchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
    relatedOrderId: { type: String, default: null },
    // Privacy-sensitive: only for reconciliation, NEVER exposed to creators
    relatedBuyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'abandoned'],
        default: 'completed',
    },
    idempotencyKey: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now, index: true },
    // For pending records: when the payment initiation expires
    expiresAt: { type: Date, default: null },
});

walletTransactionSchema.index({ walletId: 1, createdAt: -1 });
walletTransactionSchema.index({ walletId: 1, status: 1, createdAt: -1 });

// TTL index: auto-delete pending/abandoned records after 24 hours
walletTransactionSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { status: { $in: ['pending', 'abandoned'] } } }
);

const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);
export default WalletTransaction;
