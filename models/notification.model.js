import mongoose from 'mongoose';

/**
 * Notification Model
 * Stores notifications for new content uploads from subscribed creators.
 * 
 * Rules:
 * - Max 10 notifications per user (FIFO — oldest removed when >10)
 * - Clicking a notification marks it as read and removes it
 * - Only tracks new uploads from creators the user is subscribed to
 */
const NotificationSchema = new mongoose.Schema({
    // The user who receives the notification
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    // The content that was uploaded
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
        required: true
    },
    // The creator who uploaded the content
    creatorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    contentType: {
        type: String,
        enum: ['video', 'short', 'audio', 'post'],
        required: true
    },
    // Snapshot data for quick display without populating
    title: {
        type: String,
        default: ''
    },
    thumbnailUrl: {
        type: String,
        default: ''
    },
    creatorName: {
        type: String,
        default: ''
    },
    creatorChannelPicture: {
        type: String,
        default: ''
    },
    read: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Efficient query for user's notifications
NotificationSchema.index({ userId: 1, createdAt: -1 });
// For cleanup of old notifications
NotificationSchema.index({ userId: 1, createdAt: 1 });

const Notification = mongoose.model('Notification', NotificationSchema);
export default Notification;
