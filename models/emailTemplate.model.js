import mongoose from 'mongoose';

const emailTemplateSchema = new mongoose.Schema({
    templateId: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
    },
    name: {
        type: String,
        required: true,
        trim: true,
    },
    category: {
        type: String,
        required: true,
        trim: true,
        default: 'General',
    },
    icon: {
        type: String,
        default: '✉️',
    },
    subject: {
        type: String,
        default: '',
        trim: true,
    },
    body: {
        type: String,
        default: '',
    },
    isSystem: {
        type: Boolean,
        default: false,
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
    },
}, { timestamps: true });

export default mongoose.model('EmailTemplate', emailTemplateSchema);
