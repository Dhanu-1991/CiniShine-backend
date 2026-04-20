import mongoose from 'mongoose';

/**
 * Admin Audit Log — append-only immutable log of all admin actions.
 */
const AdminAuditLogSchema = new mongoose.Schema({
    admin_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        required: true
    },
    action: {
        type: String,
        required: true,
        enum: [
            'login', 'login_failed', 'login_locked',
            'signup', 'signup_approved', 'signup_rejected',
            'forgot_password_request', 'forgot_password_approved', 'forgot_password_reset',
            'content_hide', 'content_unhide', 'content_remove', 'content_restore', 'content_purge',
            'report_review', 'report_resolve', 'report_dismiss', 'report_takedown',
            'admin_remove', 'admin_block', 'admin_unblock', 'admin_unlock',
            'channel_ban', 'channel_unban', 'admin_message_sent',
            'ban_request', 'stats_update', 'email_sent',
            'otp_sent', 'otp_verified', 'otp_failed',
            'other'
        ]
    },
    target_type: {
        type: String,
        enum: ['admin', 'content', 'report', 'feedback', 'user', 'system', null],
        default: null
    },
    target_id: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    ip: {
        type: String,
        default: ''
    },
    user_agent: {
        type: String,
        default: ''
    },
    note: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: ''
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: { createdAt: 'timestamp', updatedAt: false },
    versionKey: false
});

AdminAuditLogSchema.index({ admin_id: 1, timestamp: -1 });
AdminAuditLogSchema.index({ action: 1, timestamp: -1 });
AdminAuditLogSchema.index({ target_type: 1, target_id: 1 });
AdminAuditLogSchema.index({ timestamp: -1 });

const AdminAuditLog = mongoose.model('AdminAuditLog', AdminAuditLogSchema);
export default AdminAuditLog;
