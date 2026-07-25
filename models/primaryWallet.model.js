import mongoose from 'mongoose';

/**
 * PrimaryWallet — User's main in-app credit wallet.
 * Rechargeable via Cashfree. Used for PPV purchases.
 * One per user (unique userId).
 */
const primaryWalletSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true,
    },
    balance: {
        type: Number,
        default: 0,
        min: 0,
    },
    currency: {
        type: String,
        default: 'INR',
    },
    pinHash: {
        type: String,
        default: null,
    },
    isPinSet: {
        type: Boolean,
        default: false,
    },
    isPinLocked: {
        type: Boolean,
        default: false,
    },
    failedPinAttempts: {
        type: Number,
        default: 0,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const PrimaryWallet = mongoose.model('PrimaryWallet', primaryWalletSchema);
export default PrimaryWallet;
