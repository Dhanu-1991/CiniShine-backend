import mongoose from 'mongoose';

/**
 * Content Report Model
 * Stores user reports on content in communities.
 */
const ContentReportSchema = new mongoose.Schema({
    reporterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
        required: true,
        index: true
    },
    communityId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Community',
        default: null,
        index: true
    },
    reason: {
        type: String,
        enum: [
            'spam',
            'harassment',
            'hate_speech',
            'violence',
            'nudity',
            'misinformation',
            'copyright',
            'off_topic',
            'other'
        ],
        required: true
    },
    description: {
        type: String,
        maxlength: 1000,
        trim: true,
        default: ''
    },
    status: {
        type: String,
        enum: ['pending', 'reviewed', 'resolved', 'dismissed'],
        default: 'pending',
        index: true
    },
    reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    reviewedAt: {
        type: Date,
        default: null
    },
    takenDown: {
        type: Boolean,
        default: false
    },
    takenDownAt: {
        type: Date,
        default: null
    },
    takedownJustification: {
        type: String,
        maxlength: 2000,
        trim: true,
        default: ''
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

ContentReportSchema.index({ contentId: 1, reporterId: 1 }, { unique: true });
ContentReportSchema.index({ communityId: 1, status: 1 });

const ContentReport = mongoose.model('ContentReport', ContentReportSchema);
export default ContentReport;
