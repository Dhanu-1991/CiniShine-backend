import mongoose from 'mongoose';

/**
 * ContentView — per-viewer view tracking record.
 *
 * Supports BOTH authenticated users (via userId) and anonymous visitors
 * (via visitorFingerprint = sha256(ip + userAgent + acceptLanguage)).
 *
 * Unlike WatchHistory (which users can delete), this model is NEVER deleted.
 * It provides a reliable, history-deletion-proof unique viewer count for analytics.
 *
 * lastCountedAt is used for cooldown deduplication instead of user.viewHistory.
 */
const ContentViewSchema = new mongoose.Schema({
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
        required: true,
        index: true,
    },
    // Authenticated user (null for anonymous)
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    // Anonymous visitor fingerprint: sha256(ip + userAgent + acceptLanguage)
    visitorFingerprint: {
        type: String,
        default: null,
        index: true,
    },
    ipAddress: {
        type: String,
        default: null,
    },
    firstViewedAt: {
        type: Date,
        default: Date.now,
    },
    // When the last view was actually counted (for cooldown dedup)
    lastCountedAt: {
        type: Date,
        default: null,
    },
    // Total views counted for this viewer on this content
    viewCount: {
        type: Number,
        default: 0,
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
    // No updatedAt needed — only firstViewedAt and lastCountedAt matter
    timestamps: { createdAt: 'firstViewedAt', updatedAt: false },
    versionKey: false,
});

// Authenticated viewer: unique per (content, user)
ContentViewSchema.index(
    { contentId: 1, userId: 1 },
    { unique: true, partialFilterExpression: { userId: { $ne: null } } }
);

// Anonymous viewer: unique per (content, fingerprint)
ContentViewSchema.index(
    { contentId: 1, visitorFingerprint: 1 },
    { unique: true, partialFilterExpression: { visitorFingerprint: { $ne: null } } }
);

const ContentView = mongoose.model('ContentView', ContentViewSchema);
export default ContentView;
