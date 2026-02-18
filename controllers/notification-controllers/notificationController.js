/**
 * Notification Controller
 * 
 * Endpoints:
 * - GET    /api/v2/notifications           — Get notifications (max 10, newest first)
 * - POST   /api/v2/notifications/dismiss/:id — Dismiss/remove a notification
 * - GET    /api/v2/notifications/unread-count — Get unread notification count
 * - POST   /api/v2/notifications/mark-read   — Mark all notifications as read
 * 
 * Internal:
 * - createUploadNotifications(creatorId, contentId, contentType, title, thumbnailKey)
 *   Called when a creator uploads new content to notify all subscribers.
 */

import Notification from '../../models/notification.model.js';
import User from '../../models/user.model.js';
import { getCfUrl } from '../../config/cloudfront.js';

const MAX_NOTIFICATIONS_PER_USER = 10;

/**
 * Create notifications for all subscribers of a creator when new content is uploaded.
 * Called internally from upload-complete handlers.
 * 
 * @param {string} creatorId - The creator who uploaded content
 * @param {string} contentId - The content document ID
 * @param {string} contentType - video/short/audio/post
 * @param {string} title - Content title
 * @param {string} thumbnailKey - S3 key for thumbnail (optional)
 */
export const createUploadNotifications = async (creatorId, contentId, contentType, title, thumbnailKey) => {
    try {
        // Find creator info
        const creator = await User.findById(creatorId).select('channelName channelPicture').lean();
        if (!creator) return;

        // Find all users who are subscribed to this creator
        const subscribers = await User.find(
            { subscriptions: creatorId },
            { _id: 1 }
        ).lean();

        if (subscribers.length === 0) return;

        const notifications = subscribers.map(sub => ({
            userId: sub._id,
            contentId,
            creatorId,
            contentType,
            title: title || 'New upload',
            thumbnailUrl: thumbnailKey ? getCfUrl(thumbnailKey) : '',
            creatorName: creator.channelName || '',
            creatorChannelPicture: creator.channelPicture ? getCfUrl(creator.channelPicture) : ''
        }));

        // Batch insert
        await Notification.insertMany(notifications, { ordered: false });

        // Enforce max 10 per user — remove oldest excess
        for (const sub of subscribers) {
            const count = await Notification.countDocuments({ userId: sub._id });
            if (count > MAX_NOTIFICATIONS_PER_USER) {
                const excess = count - MAX_NOTIFICATIONS_PER_USER;
                const oldestToRemove = await Notification.find({ userId: sub._id })
                    .sort({ createdAt: 1 })
                    .limit(excess)
                    .select('_id')
                    .lean();
                await Notification.deleteMany({
                    _id: { $in: oldestToRemove.map(n => n._id) }
                });
            }
        }
    } catch (error) {
        console.error('Error creating upload notifications:', error);
        // Don't throw — notifications are non-critical
    }
};

/**
 * Get user notifications (max 10, newest first)
 * GET /api/v2/notifications
 */
export const getNotifications = async (req, res) => {
    try {
        const userId = req.user.id;

        const notifications = await Notification.find({ userId })
            .sort({ createdAt: -1 })
            .limit(MAX_NOTIFICATIONS_PER_USER)
            .lean();

        return res.json({
            items: notifications,
            total: notifications.length
        });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        return res.status(500).json({ message: 'Failed to fetch notifications' });
    }
};

/**
 * Dismiss/remove a notification (when user clicks on it)
 * POST /api/v2/notifications/dismiss/:id
 */
export const dismissNotification = async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const result = await Notification.deleteOne({ _id: id, userId });
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Notification not found' });
        }

        return res.json({ message: 'Notification dismissed' });
    } catch (error) {
        console.error('Error dismissing notification:', error);
        return res.status(500).json({ message: 'Failed to dismiss notification' });
    }
};

/**
 * Get unread notification count
 * GET /api/v2/notifications/unread-count
 */
export const getUnreadNotificationCount = async (req, res) => {
    try {
        const userId = req.user.id;
        const count = await Notification.countDocuments({ userId, read: false });
        return res.json({ count });
    } catch (error) {
        console.error('Error fetching unread count:', error);
        return res.status(500).json({ message: 'Failed to fetch unread count' });
    }
};

/**
 * Mark all notifications as read
 * POST /api/v2/notifications/mark-read
 */
export const markAllNotificationsRead = async (req, res) => {
    try {
        const userId = req.user.id;
        await Notification.updateMany(
            { userId, read: false },
            { read: true }
        );
        return res.json({ message: 'All notifications marked as read' });
    } catch (error) {
        console.error('Error marking notifications as read:', error);
        return res.status(500).json({ message: 'Failed to mark as read' });
    }
};
