import mongoose from 'mongoose';

const AdminSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        maxlength: 100
    },
    contact: {
        type: String,
        required: [true, 'Contact (email/phone) is required'],
        unique: true,
        trim: true,
        lowercase: true
    },
    password_hash: {
        type: String,
        required: [true, 'Password is required']
    },
    role: {
        type: String,
        enum: ['admin', 'superadmin'],
        default: 'admin'
    },
    status: {
        type: String,
        enum: ['pending', 'active', 'blocked'],
        default: 'pending'
    },
    failed_attempts_count: {
        type: Number,
        default: 0
    },
    locked_until: {
        type: Date,
        default: null
    },
    last_login_at: {
        type: Date,
        default: null
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, { timestamps: true });

AdminSchema.index({ status: 1 });
AdminSchema.index({ role: 1 });

const Admin = mongoose.model('Admin', AdminSchema);
export default Admin;
