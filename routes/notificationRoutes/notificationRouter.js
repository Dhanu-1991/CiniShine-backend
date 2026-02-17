/**
 * Notification Router - /api/v2/notifications
 */
import express from 'express';
import {
    getNotifications,
    dismissNotification,
    getUnreadNotificationCount,
    markAllNotificationsRead
} from '../../controllers/notification-controllers/notificationController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// All notification routes require authentication
router.use(universalTokenVerifier);

// Get notifications (max 10)
router.get('/', getNotifications);

// Get unread count
router.get('/unread-count', getUnreadNotificationCount);

// Mark all as read
router.post('/mark-read', markAllNotificationsRead);

// Dismiss a specific notification
router.post('/dismiss/:id', dismissNotification);

export default router;
