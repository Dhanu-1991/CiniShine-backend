import mongoose from "mongoose";

const contentShareSchema = new mongoose.Schema({
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Content",
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
        index: true
    },
    anonymousViewerId: {
        type: String,
        default: null,
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Compound unique indexes: one share per user per content item, and one per anonymous viewer per content item
contentShareSchema.index(
    { contentId: 1, userId: 1 },
    { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } }
);

contentShareSchema.index(
    { contentId: 1, anonymousViewerId: 1 },
    { unique: true, partialFilterExpression: { anonymousViewerId: { $type: "string" } } }
);

const ContentShare = mongoose.model("ContentShare", contentShareSchema);
export default ContentShare;
