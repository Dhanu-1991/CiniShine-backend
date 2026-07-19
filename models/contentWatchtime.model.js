import mongoose from 'mongoose';

/**
 * Content Watchtime — detailed tracking of actual play time for content.
 * Excludes buffer/pause/seek time. Only tracks active consumption.
 * Works for both authenticated and anonymous users (session-based).
 */
const ContentWatchtimeSchema = new mongoose.Schema({
    eventId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true,
    },
    anonymousViewerId: {
        type: String,
        default: null,
        index: true,
    },
    sessionId: {
        type: String,
        required: true,
        index: true,
    },
    watchSessionId: {
        type: String,
        default: null,
        index: true,
    },
    eventType: {
        type: String,
        enum: ['play', 'heartbeat', 'pause', 'seek', 'ended', 'unload', 'pagehide'],
        default: 'heartbeat',
        index: true,
    },
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
        required: true,
        index: true,
    },
    contentType: {
        type: String,
        enum: ['video', 'short', 'audio', 'post'],
        required: true,
        index: true,
    },
    // Actual play time in seconds (excludes buffering, pausing, seeking)
    activePlayTime: {
        type: Number,
        required: true,
        min: 0,
    },
    playheadSeconds: {
        type: Number,
        default: 0,
        min: 0,
    },
    // Total duration of the content
    contentDuration: {
        type: Number,
        default: 0,
    },
    // Percentage of content consumed (activePlayTime / contentDuration * 100)
    consumptionPercent: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
    },
    // Whether the content was fully consumed
    completed: {
        type: Boolean,
        default: false,
    },
    isAuthenticated: {
        type: Boolean,
        default: false,
    },
    // Time breakdown
    totalBufferTime: {
        type: Number,
        default: 0,
    },
    totalPauseTime: {
        type: Number,
        default: 0,
    },
    totalSeekTime: {
        type: Number,
        default: 0,
    },
    // For posts: time spent reading
    readTime: {
        type: Number,
        default: 0,
    },
    // Date buckets
    dateBucket: {
        type: String,
        index: true,
    },
    monthBucket: {
        type: String,
        index: true,
    },
    // Creator of content (denormalized for analytics)
    creatorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true,
    },
    device: {
        type: String,
        enum: ['desktop', 'mobile', 'tablet'],
        default: 'desktop',
    },
    // ── Content-type specific metrics ──
    // Shorts/Frames
    loopCount: { type: Number, default: 0 },
    swipeAwayAt: { type: Number, default: null }, // playhead seconds when swiped away
    swipedAway: { type: Boolean, default: false },
    // Audio
    skipped: { type: Boolean, default: false },
    replayCount: { type: Number, default: 0 },
    // Posts
    impression: { type: Boolean, default: false },
    clickedThrough: { type: Boolean, default: false },
}, {
    timestamps: true,
    versionKey: false,
});

// Compound indexes for analytics
ContentWatchtimeSchema.index({ dateBucket: 1, contentType: 1 });
ContentWatchtimeSchema.index({ contentId: 1, dateBucket: 1 });
ContentWatchtimeSchema.index({ creatorId: 1, dateBucket: 1 });
ContentWatchtimeSchema.index({ userId: 1, contentType: 1, dateBucket: 1 });
ContentWatchtimeSchema.index({ contentId: 1, watchSessionId: 1 });
ContentWatchtimeSchema.index({ contentId: 1, anonymousViewerId: 1 });
ContentWatchtimeSchema.index({ contentId: 1, userId: 1 });

const ContentWatchtime = mongoose.model('ContentWatchtime', ContentWatchtimeSchema);
export default ContentWatchtime;
