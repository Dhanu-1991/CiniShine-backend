import mongoose from 'mongoose';

/**
 * Watch History Schema
 * Tracks all content watched by users (videos, shorts, audio, posts)
 * Used for building personalized recommendations
 */
const WatchHistorySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    // Content reference - can be Video or Content model
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },

    // Content type for efficient querying
    contentType: {
        type: String,
        enum: ['video', 'short', 'audio', 'post'],
        required: true,
        index: true
    },

    // Watch metrics
    watchTime: {
        type: Number, // in seconds
        default: 0
    },
    watchPercentage: {
        type: Number, // 0-100
        default: 0
    },
    completedWatch: {
        type: Boolean,
        default: false
    },

    // Engagement signals
    liked: {
        type: Boolean,
        default: false
    },
    disliked: {
        type: Boolean,
        default: false
    },
    commented: {
        type: Boolean,
        default: false
    },
    shared: {
        type: Boolean,
        default: false
    },

    // Content metadata snapshot (for recommendations even if content deleted)
    contentMetadata: {
        title: String,
        tags: [String],
        category: String,
        creatorId: mongoose.Schema.Types.ObjectId,
        duration: Number
    },

    // Session tracking
    sessions: [{
        startedAt: Date,
        endedAt: Date,
        watchTime: Number,
        device: String,
        completedWatch: Boolean
    }],

    // Timestamps
    firstWatchedAt: {
        type: Date,
        default: Date.now
    },
    lastWatchedAt: {
        type: Date,
        default: Date.now
    },
    watchCount: {
        type: Number,
        default: 1
    }
});

// Compound indexes for efficient queries
WatchHistorySchema.index({ userId: 1, contentType: 1, lastWatchedAt: -1 });
WatchHistorySchema.index({ userId: 1, contentId: 1 }, { unique: true });
WatchHistorySchema.index({ userId: 1, 'contentMetadata.tags': 1 });
WatchHistorySchema.index({ userId: 1, 'contentMetadata.category': 1 });
WatchHistorySchema.index({ userId: 1, 'contentMetadata.creatorId': 1 });

const WatchHistory = mongoose.model('WatchHistory', WatchHistorySchema);

export default WatchHistory;
