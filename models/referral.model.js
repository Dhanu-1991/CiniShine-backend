import mongoose from 'mongoose';

const referralSchema = new mongoose.Schema({
    referrerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    referredUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true,
    },
    referralCode: {
        type: String,
        required: true,
    },
    status: {
        type: String,
        enum: ['pending', 'content_uploaded', 'approved', 'rejected', 'partial_approved'],
        default: 'pending',
    },
    rejectionReason: {
        type: String,
    },
    partialRejectionReason: {
        type: String,
    },
    rejectedParty: {
        type: String,
        enum: ['referrer', 'referred'],
    },
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
    },
    approvedAt: {
        type: Date,
    },
    rejectedAt: {
        type: Date,
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
    },
    referrerCredited: {
        type: Boolean,
        default: false,
    },
    referredCredited: {
        type: Boolean,
        default: false,
    },
    referrerTransactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'WalletTransaction',
    },
    referredTransactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'WalletTransaction',
    },
    referrerBonusAmount: {
        type: Number,
        default: null, // Set at approval time
    },
    referredBonusAmount: {
        type: Number,
        default: null, // Set at approval time
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

referralSchema.index({ referrerId: 1, createdAt: -1 });
referralSchema.index({ status: 1 });
referralSchema.index({ referralCode: 1 });

const Referral = mongoose.model('Referral', referralSchema);
export default Referral;
