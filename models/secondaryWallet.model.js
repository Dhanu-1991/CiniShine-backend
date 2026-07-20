import mongoose from 'mongoose';

/**
 * SecondaryWallet — Creator's settlement/earnings wallet.
 * 
 * MONEY-IN:  Only PPV purchase credits (70% of price) via service layer.
 * MONEY-OUT: Transfer-to-primary or month-end payout.
 * 
 * GUARD: This wallet CANNOT be recharged directly. The only code path that
 * credits money into it is executePpvPurchase() in walletService.js.
 * Any attempt to call executeRecharge() for this wallet type will throw.
 * 
 * KYC status is now tracked in the separate KycDetails model.
 * This model only stores balance and ownership.
 */
const secondaryWalletSchema = new mongoose.Schema({
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
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const SecondaryWallet = mongoose.model('SecondaryWallet', secondaryWalletSchema);
export default SecondaryWallet;
