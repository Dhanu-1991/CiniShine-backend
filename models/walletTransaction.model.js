import mongoose from 'mongoose';

const walletTransactionSchema = new mongoose.Schema({
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    type: {
        type: String,
        enum: [
            'recharge',
            'ppv_purchase_debit',
            'ppv_earning_credit',
            'payout',
            'payout_fee',
            'transfer_to_primary',
            'transfer_from_settlement',
            'adjustment'
        ],
        required: true
    },
    amount: { type: Number, required: true },  // always positive
    balanceAfter: { type: Number, required: true },
    relatedContentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', default: null },
    relatedPurchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
    relatedOrderId: { type: String, default: null },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },
    idempotencyKey: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now, index: true },
});

walletTransactionSchema.index({ walletId: 1, createdAt: -1 });

const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);
export default WalletTransaction;
