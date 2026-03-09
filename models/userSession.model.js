import mongoose from 'mongoose';

/**
 * User Session — tracks individual platform sessions.
 * A session starts when user opens the platform and ends when they leave.
 * Works for both authenticated and anonymous users.
 */
const UserSessionSchema = new mongoose.Schema({
    sessionId: {
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
    // Whether the user was logged in during this session
    isAuthenticated: {
        type: Boolean,
        default: false,
    },
    // Session timing
    startedAt: {
        type: Date,
        required: true,
    },
    lastActiveAt: {
        type: Date,
        default: Date.now,
    },
    endedAt: {
        type: Date,
        default: null,
    },
    // Total active duration in seconds (updated via heartbeat)
    totalDuration: {
        type: Number,
        default: 0,
    },
    // Pages visited during this session
    pagesVisited: [{
        pageName: String,
        timeSpent: Number, // seconds
        visitedAt: Date,
    }],
    // Device info
    device: {
        type: String,
        enum: ['desktop', 'mobile', 'tablet'],
        default: 'desktop',
    },
    userAgent: {
        type: String,
        default: '',
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
}, {
    timestamps: true,
    versionKey: false,
});

// Compound indexes for analytics
UserSessionSchema.index({ dateBucket: 1, isAuthenticated: 1 });
UserSessionSchema.index({ userId: 1, dateBucket: 1 });
UserSessionSchema.index({ startedAt: 1 });

const UserSession = mongoose.model('UserSession', UserSessionSchema);
export default UserSession;
