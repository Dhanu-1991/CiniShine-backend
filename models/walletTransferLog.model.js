import mongoose from 'mongoose';

const walletTransferLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fromWalletId: { type: mongoose.Schema.Types.ObjectId, ref: 'SecondaryWallet', required: true },
    toWalletId: { type: mongoose.Schema.Types.ObjectId, ref: 'PrimaryWallet', required: true },
    amount: { type: Number, required: true },
    direction: { type: String, enum: ['settlement_to_primary'], default: 'settlement_to_primary' },
    reversible: { type: Boolean, default: false },
    idempotencyKey: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now },
});

const WalletTransferLog = mongoose.model('WalletTransferLog', walletTransferLogSchema);
export default WalletTransferLog;
