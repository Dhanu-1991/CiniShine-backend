import mongoose from 'mongoose';

const payoutSchema = new mongoose.Schema({
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    grossAmount: { type: Number, required: true },
    feeAmount: { type: Number, required: true },   // 1% maintenance fee
    netAmount: { type: Number, required: true },     // grossAmount - feeAmount

    // Encrypted snapshot of bank details at time of payout
    bankAccountNumberEncrypted: { type: String, required: true },
    bankAccountIv: { type: String, required: true },
    bankAccountTag: { type: String, required: true },
    ifscCodeEncrypted: { type: String, required: true },
    ifscCodeIv: { type: String, required: true },
    ifscCodeTag: { type: String, required: true },
    accountHolderNameEncrypted: { type: String, required: true },
    accountHolderNameIv: { type: String, required: true },
    accountHolderNameTag: { type: String, required: true },
    bankName: { type: String, required: true },

    status: {
        type: String,
        enum: ['pending_settlement', 'processing', 'completed', 'failed'],
        default: 'pending_settlement'
    },
    payoutMonth: { type: String, required: true },   // '2026-07' format
    scheduledFor: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
});

// Prevents double payout per wallet per month
payoutSchema.index({ walletId: 1, payoutMonth: 1 }, { unique: true });
payoutSchema.index({ payoutMonth: 1, status: 1 });

const Payout = mongoose.model('Payout', payoutSchema);
export default Payout;
