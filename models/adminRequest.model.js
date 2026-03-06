import mongoose from 'mongoose';

const AdminRequestSchema = new mongoose.Schema({
    requester_contact: {
        type: String,
        required: true,
        trim: true
    },
    type: {
        type: String,
        enum: ['forgot_password_activation', 'signup'],
        required: true
    },
    reason: {
        type: String,
        trim: true,
        maxlength: 500,
        default: ''
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    reviewed_by_admin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    review_note: {
        type: String,
        trim: true,
        default: ''
    }
}, { timestamps: true });

AdminRequestSchema.index({ status: 1, type: 1 });
AdminRequestSchema.index({ requester_contact: 1 });

const AdminRequest = mongoose.model('AdminRequest', AdminRequestSchema);
export default AdminRequest;
