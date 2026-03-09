import mongoose from 'mongoose';

/**
 * Analytics Summary — pre-aggregated analytics for fast dashboard queries.
 * Updated periodically (hourly/daily) via aggregation pipeline or on-demand.
 */
const AnalyticsSummarySchema = new mongoose.Schema({
    // Time period this summary covers
    period: {
        type: String,
        enum: ['daily', 'weekly', 'monthly'],
        required: true,
        index: true,
    },
    // Date key, e.g. "2025-01-15" for daily, "2025-W03" for weekly, "2025-01" for monthly
    dateKey: {
        type: String,
        required: true,
        index: true,
    },
    // Platform usage
    totalSessions: { type: Number, default: 0 },
    authenticatedSessions: { type: Number, default: 0 },
    anonymousSessions: { type: Number, default: 0 },
    avgSessionDuration: { type: Number, default: 0 }, // seconds
    totalPlatformTime: { type: Number, default: 0 }, // seconds

    // Page usage breakdown
    pageUsage: {
        dashboard: { type: Number, default: 0 },
        watch: { type: Number, default: 0 },
        shorts: { type: Number, default: 0 },
        audio: { type: Number, default: 0 },
        post: { type: Number, default: 0 },
        communities: { type: Number, default: 0 },
        community_feed: { type: Number, default: 0 },
        community_chat: { type: Number, default: 0 },
        history: { type: Number, default: 0 },
        chats: { type: Number, default: 0 },
        search: { type: Number, default: 0 },
        profile: { type: Number, default: 0 },
        studio: { type: Number, default: 0 },
        upload: { type: Number, default: 0 },
        settings: { type: Number, default: 0 },
        bookmarks: { type: Number, default: 0 },
        channel: { type: Number, default: 0 },
    },

    // Content watchtime totals (in seconds)
    contentWatchtime: {
        video: { type: Number, default: 0 },
        short: { type: Number, default: 0 },
        audio: { type: Number, default: 0 },
        post: { type: Number, default: 0 },
    },

    // Content consumption counts
    contentConsumed: {
        video: { type: Number, default: 0 },
        short: { type: Number, default: 0 },
        audio: { type: Number, default: 0 },
        post: { type: Number, default: 0 },
    },

    // Top content (most watched)
    topContent: [{
        contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
        contentType: String,
        title: String,
        totalPlayTime: Number,
        viewCount: Number,
    }],

    // Device breakdown
    deviceBreakdown: {
        desktop: { type: Number, default: 0 },
        mobile: { type: Number, default: 0 },
        tablet: { type: Number, default: 0 },
    },

    // Unique users
    uniqueUsers: { type: Number, default: 0 },
    newUsers: { type: Number, default: 0 },
}, {
    timestamps: true,
    versionKey: false,
});

// Unique compound index — one summary per period+dateKey
AnalyticsSummarySchema.index({ period: 1, dateKey: 1 }, { unique: true });

const AnalyticsSummary = mongoose.model('AnalyticsSummary', AnalyticsSummarySchema);
export default AnalyticsSummary;
