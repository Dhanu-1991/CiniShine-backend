import mongoose from 'mongoose';

/**
 * Unified Content Model
 * Handles: shorts, audio, posts
 * Videos use the existing video.model.js
 */
const ContentSchema = new mongoose.Schema({
    // Content type discriminator
    contentType: {
        type: String,
        enum: ['short', 'audio', 'post'],
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
        required: true,
        trim: true,
        maxlength: 200
    },
    description: {
        type: String,
        trim: true,
        maxlength: 5000
    },

    // Channel info (denormalized for quick access)
    channelName: {
        type: String,
        trim: true
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

    // Media files (S3 keys)
    originalKey: String,        // Original file key in S3
    hlsMasterKey: String,       // For shorts: HLS master playlist
    thumbnailKey: String,       // Thumbnail/cover art
    imageKey: String,           // For posts: attached image

    // Media metadata
    duration: Number,           // In seconds (for shorts/audio)
    fileSize: Number,           // In bytes
    mimeType: String,

    // Processing status
    status: {
        type: String,
        enum: ['uploading', 'processing', 'completed', 'failed'],
        default: 'uploading'
    },
    processingStart: Date,
    processingEnd: Date,
    processingError: String,

    // Renditions (for shorts that need transcoding)
    renditions: [{
        resolution: String,
        bitrate: Number,
        playlistKey: String,
        codecs: String
    }],

    // Engagement metrics
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
    commentCount: {
        type: Number,
        default: 0
    },
    shareCount: {
        type: Number,
        default: 0
    },

    // Audio-specific fields
    audioCategory: {
        type: String,
        enum: ['music', 'podcast', 'audiobook', 'sound-effect', 'other'],
        default: 'music'
    },
    artist: String,
    album: String,

    // Post-specific fields
    postContent: String,        // Text content for posts

    // Timestamps
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

// Indexes for efficient queries
ContentSchema.index({ contentType: 1, status: 1, createdAt: -1 });
ContentSchema.index({ userId: 1, contentType: 1 });
ContentSchema.index({ tags: 1 });
ContentSchema.index({ visibility: 1, status: 1 });

// Update timestamp on save
ContentSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

const Content = mongoose.model('Content', ContentSchema);

export default Content;
