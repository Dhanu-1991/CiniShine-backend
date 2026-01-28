import mongoose from "mongoose";

const videoReactionSchema = new mongoose.Schema({
    videoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Video",
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ["like", "dislike"],
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Compound unique index: one reaction per user per video
videoReactionSchema.index(
    { videoId: 1, userId: 1 },
    { unique: true }
);

const VideoReaction = mongoose.model("VideoReaction", videoReactionSchema);
export default VideoReaction;
