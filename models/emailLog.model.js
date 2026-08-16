import mongoose from 'mongoose';

const emailLogSchema = new mongoose.Schema({
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        required: false,
    },
    adminEmail: {
        type: String,
    },
    recipientType: {
        type: String,
        enum: ['selected', 'filtered', 'individual', 'system', 'all'],
        default: 'individual',
    },
    recipientIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    }],
    recipientCount: {
        type: Number,
        default: 1,
    },
    successCount: {
        type: Number,
        default: 1,
    },
    failCount: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ['success', 'failed', 'partial'],
        default: 'success',
    },
    subject: {
        type: String,
        required: true,
    },
    body: {
        type: String,
    },
    bodyPreview: {
        type: String,
        maxlength: 1000,
    },
    templateId: {
        type: String,
    },
    template: {
        name: String,
        category: String,
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
