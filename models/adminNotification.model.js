import mongoose from 'mongoose';

/**
 * Admin Notification — dashboard alerts for admins.
 */
const AdminNotificationSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: [
            'account_locked', 'new_signup_pending', 'forgot_password_request',
            'content_removed', 'content_restored', 'system_alert',
            'report_new', 'admin_removed'
        ],
        required: true
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    message: {
        type: String,
        trim: true,
        default: ''
    },
    severity: {
        type: String,
        enum: ['info', 'warning', 'critical'],
        default: 'info'
    },
    read_by: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin'
    }],
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, { timestamps: true });

AdminNotificationSchema.index({ createdAt: -1 });
AdminNotificationSchema.index({ type: 1 });

const AdminNotification = mongoose.model('AdminNotification', AdminNotificationSchema);
export default AdminNotification;
