import mongoose from "mongoose";

const commentSchema = new mongoose.Schema({
    // Support both videos and content (shorts, audio, posts)
    // videoId is kept for backward compatibility with existing video comments
    videoId: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: 'onModel',
        required: true,
        index: true
    },
    // Specifies which model the videoId references
    onModel: {
        type: String,
        enum: ['Video', 'Content'],
        default: 'Video'
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true
    },
    // userName and userProfilePic are deprecated - we fetch live from User via populate
    // Kept for backward compatibility with old comments
    userName: {
        type: String,
        required: false,
        default: null
    },
    userProfilePic: {
        type: String,
        default: null
    },
    text: {
        type: String,
        required: true,
        maxlength: 5000
    },
    likes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    }],
    likeCount: {
        type: Number,
        default: 0
    },
    replies: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Comment"
    }],
    replyCount: {
        type: Number,
        default: 0
    },
    parentCommentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Comment",
        default: null
    },
    isEdited: {
        type: Boolean,
        default: false
    },
    editedAt: {
        type: Date,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    }
});

// Compound index for finding comments by video
commentSchema.index({ videoId: 1, createdAt: -1 });

// Index for finding replies to a comment
commentSchema.index({ parentCommentId: 1, createdAt: -1 });

const Comment = mongoose.model("Comment", commentSchema);
export default Comment;
