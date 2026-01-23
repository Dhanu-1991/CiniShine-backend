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
    profilePicture: {
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
    channelDescription: {
        type: String,
        required: false,
        trim: true,
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
});

const User = mongoose.model("User", userSchema);
export default User;
