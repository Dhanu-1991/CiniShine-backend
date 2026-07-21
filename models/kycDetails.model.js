import mongoose from 'mongoose';

/**
 * KycDetails — Standalone KYC document per user.
 * Extracted from the old embedded Wallet KYC fields.
 *
 * DESIGN DECISION: Editing KYC after submission resets kycStatus to 'pending'
 * so admin can re-verify the new details before they go live.
 */
const kycDetailsSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true,
    },

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
    kycDocumentType: {
        type: String,
        enum: ['passbook', 'cancelled_cheque'],
        default: null,
    },

    // Verification status
    kycStatus: {
        type: String,
        enum: ['not_started', 'pending', 'submitted', 'verified', 'rejected'],
        default: 'not_started',
    },

    // Timestamps
    submittedAt: { type: Date, default: null },
    lastEditedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
}, {
    timestamps: true,
});

const KycDetails = mongoose.model('KycDetails', kycDetailsSchema);
export default KycDetails;
