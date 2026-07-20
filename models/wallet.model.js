import mongoose from 'mongoose';

const walletSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['primary', 'settlement'], required: true },
    balance: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR' },

    // KYC fields (only relevant for settlement wallets)
    kycStatus: { type: String, enum: ['not_started', 'submitted', 'rejected'], default: 'not_started' },

    // Encrypted bank details (AES-256-GCM)
    bankAccountNumberEncrypted: { type: String, default: null },
    bankAccountIv: { type: String, default: null },
    bankAccountTag: { type: String, default: null },

    bankNameEncrypted: { type: String, default: null },
    bankNameIv: { type: String, default: null },
    bankNameTag: { type: String, default: null },

    ifscCodeEncrypted: { type: String, default: null },
    ifscCodeIv: { type: String, default: null },
    ifscCodeTag: { type: String, default: null },

    accountHolderNameEncrypted: { type: String, default: null },
    accountHolderNameIv: { type: String, default: null },
    accountHolderNameTag: { type: String, default: null },

    // KYC document stored in private S3 bucket
    kycDocumentKey: { type: String, default: null },
    kycDocumentType: { type: String, enum: ['passbook', 'cancelled_cheque'], default: null },

    createdAt: { type: Date, default: Date.now },
});

// One primary wallet and one settlement wallet per user
walletSchema.index({ userId: 1, type: 1 }, { unique: true });

const Wallet = mongoose.model('Wallet', walletSchema);
export default Wallet;
