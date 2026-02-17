import mongoose from 'mongoose';

/**
 * Message Model
 * Stores direct messages between users and creators.
 * 
 * Routing logic:
 * - If sender is subscribed to recipient → message goes to "chats"
 * - If sender is NOT subscribed → message goes to "requests"
 * 
 * Creator can "accept" a request (moves to chats) or "ignore" (archives it).
 */
const MessageSchema = new mongoose.Schema({
    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    recipientId: {
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
    // Whether sender was subscribed to recipient at time of sending
    senderIsSubscriber: {
        type: Boolean,
        default: false
    },
    read: {
        type: Boolean,
        default: false
    },
    // For request handling: archived means "ignored" by the creator
    archived: {
        type: Boolean,
        default: false,
        index: true
    },
    // Once a request is accepted, it becomes a regular chat
    accepted: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Efficient queries for chat threads
MessageSchema.index({ senderId: 1, recipientId: 1, createdAt: -1 });
MessageSchema.index({ recipientId: 1, senderId: 1, createdAt: -1 });
// For unread count
MessageSchema.index({ recipientId: 1, read: 1 });

const Message = mongoose.model('Message', MessageSchema);
export default Message;
