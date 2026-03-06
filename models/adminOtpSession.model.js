import mongoose from 'mongoose';

const OtpSessionSchema = new mongoose.Schema({
    admin_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    contact: {
        type: String,
        required: true,
        trim: true
    },
    otp_hash: {
        type: String,
        required: true
    },
    channel: {
        type: String,
        enum: ['sms', 'email'],
        required: true
    },
    purpose: {
        type: String,
        enum: ['login', 'signup', 'forgot_password'],
        required: true
    },
    attempts: {
        type: Number,
        default: 0
    },
    expires_at: {
        type: Date,
        required: true
    }
}, { timestamps: true });

OtpSessionSchema.index({ contact: 1, purpose: 1 });
OtpSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

const OtpSession = mongoose.model('OtpSession', OtpSessionSchema);
export default OtpSession;
