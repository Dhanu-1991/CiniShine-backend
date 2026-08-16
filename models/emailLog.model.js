import mongoose from 'mongoose';

const emailLogSchema = new mongoose.Schema({
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        required: true,
    },
    recipientType: {
        type: String,
        enum: ['selected', 'filtered', 'individual', 'system'],
        required: true,
    },
    recipientIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    }],
    recipientCount: {
        type: Number,
        default: 0,
    },
    successCount: {
        type: Number,
        default: 0,
    },
    failCount: {
        type: Number,
        default: 0,
    },
    subject: {
        type: String,
        required: true,
    },
    bodyPreview: {
        type: String,
        maxlength: 500,
    },
    templateId: {
        type: String,
    },
    filters: {
        type: mongoose.Schema.Types.Mixed,
    },
    sentAt: {
        type: Date,
        default: Date.now,
    },
}, { timestamps: true });

emailLogSchema.index({ sentAt: -1 });
emailLogSchema.index({ adminId: 1, sentAt: -1 });

export default mongoose.model('EmailLog', emailLogSchema);
