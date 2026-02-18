import mongoose from 'mongoose';

/**
 * ContentView — immutable per-user first-view record.
 *
 * Unlike WatchHistory (which users can delete), this model is NEVER deleted.
 * It provides a reliable, history-deletion-proof unique viewer count for analytics.
 *
 * One document per (contentId, userId) pair — a unique sparse index prevents duplicates.
 * Created via upsert with $setOnInsert so it is written exactly once per user per video.
 */
const ContentViewSchema = new mongoose.Schema({
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
        required: true,
        index: true,
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    firstViewedAt: {
        type: Date,
        default: Date.now,
    },
    // Optional: track the week/month bucket for fast aggregated queries
    weekBucket: {
        type: String,  // e.g. "2025-W03"
        index: true,
    },
    monthBucket: {
        type: String,  // e.g. "2025-01"
        index: true,
    },
}, {
    // No updatedAt needed — this record never changes after creation
    timestamps: { createdAt: 'firstViewedAt', updatedAt: false },
    versionKey: false,
});

// Composite unique index — prevents duplicate entries, makes countDocuments fast
ContentViewSchema.index({ contentId: 1, userId: 1 }, { unique: true });

const ContentView = mongoose.model('ContentView', ContentViewSchema);
export default ContentView;
