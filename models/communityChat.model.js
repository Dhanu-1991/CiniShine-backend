import mongoose from 'mongoose';

/**
 * Community Chat Message Model
 * Stores messages in community chat rooms.
 * Each community has one chat room.
 */
const CommunityChatSchema = new mongoose.Schema({
    communityId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Community',
        required: true,
        index: true
    },
    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    text: {
        type: String,
        required: true,
        maxlength: 2000,
        trim: true
    },
    // Content context — when user navigates to chat via a feed item
    contentRef: {
        contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', default: null },
        title: { type: String, default: null },
        contentType: { type: String, enum: ['video', 'short', 'audio', 'post', null], default: null },
        thumbnailKey: { type: String, default: null }
    },
    // Reply to another message
    replyTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'CommunityChat',
        default: null
    },
    // Edit tracking
    editedAt: {
        type: Date,
        default: null
    },
    // Soft delete — "deleted for everyone" leaves a placeholder
    deletedForEveryone: {
        type: Boolean,
        default: false
    },
    deletedForEveryoneAt: {
        type: Date,
        default: null
    },
    deletedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

CommunityChatSchema.index({ communityId: 1, createdAt: -1 });
CommunityChatSchema.index({ communityId: 1, text: 'text' });

const CommunityChat = mongoose.model('CommunityChat', CommunityChatSchema);
export default CommunityChat;
