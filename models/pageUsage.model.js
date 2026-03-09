import mongoose from 'mongoose';

/**
 * Page Usage — tracks time spent on each page/section of the platform.
 * Works for both authenticated and anonymous users (session-based).
 */
const PageUsageSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true,
    },
    sessionId: {
        type: String,
        required: true,
        index: true,
    },
    pageName: {
        type: String,
        required: true,
        enum: [
            'dashboard', 'watch', 'shorts', 'audio', 'post',
            'communities', 'community_feed', 'community_chat',
            'history', 'chats', 'search', 'profile', 'studio',
            'upload', 'settings', 'bookmarks', 'channel',
        ],
        index: true,
    },
    // Actual time spent on page in seconds (excluding hidden/inactive tab)
    timeSpent: {
        type: Number,
        required: true,
        min: 0,
    },
    // When the page visit started
    enteredAt: {
        type: Date,
        required: true,
    },
    // When the page visit ended
    exitedAt: {
        type: Date,
        default: null,
    },
    // Date bucket for fast aggregation queries
    dateBucket: {
        type: String, // e.g. "2025-01-15"
        index: true,
    },
    monthBucket: {
        type: String, // e.g. "2025-01"
        index: true,
    },
    // Device info
    device: {
        type: String,
        enum: ['desktop', 'mobile', 'tablet'],
        default: 'desktop',
    },
}, {
    timestamps: true,
    versionKey: false,
});

// Compound indexes for admin analytics queries
PageUsageSchema.index({ dateBucket: 1, pageName: 1 });
PageUsageSchema.index({ userId: 1, dateBucket: 1 });
PageUsageSchema.index({ createdAt: 1 });

const PageUsage = mongoose.model('PageUsage', PageUsageSchema);
export default PageUsage;
