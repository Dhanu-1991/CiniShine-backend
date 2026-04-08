import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    contact: {
        type: String,
        required: [true, "Please provide a contact "],
        unique: true
    },
    userName: {
        type: String,
        required: [true, "Please provide a username"],
    },
    fullName: {
        type: String,
        required: false,
    },
    password: {
        type: String,
        required: [true, "Please provide a password"],
    },
    googleId: {
        type: String,
        required: false,
        unique: true,
        sparse: true,
    },
    authProvider: {
        type: String,
        enum: ["local", "google"],
        default: "local",
    },
    emailVerified: {
        type: Boolean,
        default: false,
    },
    profilePicture: {
        type: String,
        required: false,
    },
    channelPicture: {
        type: String,
        required: false,
    },
    selectedRolesId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SelectedRole",
        required: false,
    },

    // Quality preferences
    preferredQuality: {
        type: String,
        default: "auto",
        enum: ["auto", "144p", "360p", "480p", "720p", "1080p", "1440p", "2160p"]
    },
    autoQualityEnabled: {
        type: Boolean,
        default: true
    },
    stableVolumeEnabled: {
        type: Boolean,
        default: true
    },
    playbackSpeed: {
        type: Number,
        default: 1.0,
        min: 0.25,
        max: 4.0
    },

    roles: {
        type: [String],
        enum: ["Actor", "Writer", "Director", "Singer", "Producer", "Cinematographer", "Editor"],
        required: false,

    },
    channelName: {
        type: String,
        required: false,
        trim: true,
    },
    channelHandle: {
        type: String,
        required: false,
        trim: true,
        unique: true,
        sparse: true,
        lowercase: true,
    },
    channelDescription: {
        type: String,
        required: false,
        trim: true,
    },
    bio: {
        type: String,
        trim: true,
        maxlength: 500,
    },
    achievements: [{
        type: String,
        trim: true,
    }],
    historyPaused: {
        type: Boolean,
        default: false,
    },
    subscriptions: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    viewHistory: [{
        videoId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Video'
        },
        lastViewedAt: {
            type: Date
        },
        ipAddress: String,
        userAgent: String
    }],
    // Last login tracking
    lastLoginAt: {
        type: Date,
        default: null
    },
    // Subscriber count override (superadmin can set this)
    subscriberCountOverride: {
        type: Number,
        default: null
    },
    // Unique viewers override (superadmin can set this)
    uniqueViewersOverride: {
        type: Number,
        default: null
    },
    // Admin channel ban
    channelBanned: {
        type: Boolean,
        default: false
    },
    channelBannedAt: {
        type: Date,
        default: null
    },
    channelBanReason: {
        type: String,
        default: null
    },
});

const User = mongoose.model("User", userSchema);
export default User;
