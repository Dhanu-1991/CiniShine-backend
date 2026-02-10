import mongoose from 'mongoose';

/**
 * Unified Content Model
 * Handles ALL content types: video, short, audio, post
 * Single model replaces the old separate Video + Content models
 */
const ContentSchema = new mongoose.Schema({
    // Content type discriminator
    contentType: {
        type: String,
        enum: ['video', 'short', 'audio', 'post'],
        required: true,
        index: true
    },

    // Creator reference
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    // Basic metadata
    title: {
        type: String,
        trim: true,
        maxlength: 200
    },
    description: {
        type: String,
        trim: true,
        maxlength: 5000
    },

    // Tags and categorization
    tags: [{
        type: String,
        trim: true
    }],
    category: {
        type: String,
        trim: true
    },

    // Content settings
    visibility: {
        type: String,
        enum: ['public', 'unlisted', 'private'],
        default: 'public'
    },
    isAgeRestricted: {
        type: Boolean,
        default: false
    },
    commentsEnabled: {
        type: Boolean,
        default: true
    },

    // Creator roles associated with this content
    selectedRoles: [{
        type: String,
        trim: true
    }],

    // ============================================
    // MEDIA FILES (S3 keys)
    // ============================================
    originalKey: String,
    hlsMasterKey: String,
    thumbnailKey: String,
    thumbnailSource: {
        type: String,
        enum: ['auto', 'custom'],
        default: 'auto'
    },
    imageKey: String,
    imageKeys: [{
        type: String,
        trim: true
    }],

    // ============================================
    // MEDIA METADATA
    // ============================================
    duration: Number,
    fileSize: Number,
    mimeType: String,
    sizes: {
        original: Number,
        processed: Number,
    },

    // Processing status
    status: {
        type: String,
        enum: ['uploading', 'processing', 'completed', 'failed'],
        default: 'uploading'
    },
    processingStart: Date,
    processingEnd: Date,
    processingError: String,

    // Renditions (for video/shorts transcoding)
    renditions: [{
        resolution: String,
        bitrate: Number,
        playlistKey: String,
        codecs: String
    }],

    // ============================================
    // ENGAGEMENT METRICS
    // ============================================
    views: {
        type: Number,
        default: 0
    },
    likeCount: {
        type: Number,
        default: 0
    },
    dislikeCount: {
        type: Number,
        default: 0
    },
    shareCount: {
        type: Number,
        default: 0
    },

    // ============================================
    // VIDEO/SHORTS ANALYTICS
    // ============================================
    lastViewedAt: Date,
    averageWatchTime: {
        type: Number,
        default: 0
    },
    // NOTE: watchCount was removed from Content model - it was dead/unused code.
    // The watchCount in WatchHistory model (per-user re-watch count) is still used
    // by the recommendation algorithm (watchHistoryRecommendation.js) for "rewatch bonus".
    totalWatchTime: {
        type: Number,
        default: 0
    },

    // ============================================
    // AUDIO-SPECIFIC FIELDS
    // ============================================
    audioCategory: {
        type: String,
        enum: ['music', 'podcast', 'audiobook', 'sound-effect', 'other'],
        default: 'music'
    },
    artist: String,
    album: String,

    // ============================================
    // POST-SPECIFIC FIELDS
    // ============================================
    postContent: String,

    // ============================================
    // TIMESTAMPS
    // ============================================
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    publishedAt: Date
});

// ============================================
// INDEXES
// ============================================
ContentSchema.index({ contentType: 1, status: 1, createdAt: -1 });
ContentSchema.index({ userId: 1, contentType: 1 });
ContentSchema.index({ tags: 1 });
ContentSchema.index({ visibility: 1, status: 1 });
ContentSchema.index({ contentType: 1, status: 1, views: -1 });
ContentSchema.index({ contentType: 1, visibility: 1, createdAt: -1 });

// Update timestamp on save
ContentSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

const Content = mongoose.model('Content', ContentSchema);

export default Content;
