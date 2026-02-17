import mongoose from 'mongoose';

/**
 * Conversation Model
 * Tracks conversation threads between two users.
 * Determines if a conversation is in "chats" or "requests" state.
 */
const ConversationSchema = new mongoose.Schema({
    // Always store participants sorted by ObjectId for consistent lookup
    participants: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }],
    // The user who initiated the conversation
    initiatorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    // The creator/recipient of the initial message
    creatorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    // Whether the initiator was subscribed when they first messaged
    initiatorIsSubscriber: {
        type: Boolean,
        default: false
    },
    // Whether the creator has accepted this conversation (moves from requests to chats)
    accepted: {
        type: Boolean,
        default: false
    },
    // Whether the creator has archived/ignored this conversation
    archived: {
        type: Boolean,
        default: false,
        index: true
    },
    // Last message info for preview
    lastMessage: {
        text: { type: String, default: '' },
        senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now }
    },
    // Unread counts per participant
    unreadCount: {
        type: Map,
        of: Number,
        default: {}
    },
    // ─── Group chat fields ───────────────────────────────────────────
    isGroup: {
        type: Boolean,
        default: false
    },
    groupName: {
        type: String,
        default: ''
    },
    // Optional uploaded group picture (S3 key)
    groupPictureKey: {
        type: String,
        default: null
    },
    // User IDs who are admins of this group
    adminIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    // Pending invitations: { userId, invitedBy }
    pendingInvites: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    }],
    // ─── Soft-delete per user ───────────────────────────────────────
    // When a user hides the conversation, we store their userId here.
    // The conversation is hidden only for them; the other side is unaffected.
    deletedBy: {
        type: Map,
        of: Date,
        default: {}
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Efficient lookup by participant pair
ConversationSchema.index({ participants: 1 });
// For listing chats/requests for a user
ConversationSchema.index({ creatorId: 1, accepted: 1, archived: 1, updatedAt: -1 });
ConversationSchema.index({ 'participants': 1, updatedAt: -1 });

const Conversation = mongoose.model('Conversation', ConversationSchema);
export default Conversation;
