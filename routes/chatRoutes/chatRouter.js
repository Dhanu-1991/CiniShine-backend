/**
 * Chat Router - /api/v2/chats
 */
import express from 'express';
import {
    sendMessage,
    getConversations,
    getRequests,
    getConversationMessages,
    acceptRequest,
    ignoreRequest,
    getUnreadCount,
    markConversationRead,
    searchConversations
} from '../../controllers/chat-controllers/chatController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// All chat routes require authentication
router.use(universalTokenVerifier);

// Send a message
router.post('/send', sendMessage);

// Get conversations (chats tab)
router.get('/conversations', getConversations);

// Get message requests
router.get('/requests', getRequests);

// Search conversations
router.get('/search', searchConversations);

// Get unread count
router.get('/unread-count', getUnreadCount);

// Get messages in a specific conversation
router.get('/conversation/:userId', getConversationMessages);

// Accept a message request
router.post('/accept/:conversationId', acceptRequest);

// Ignore/archive a message request
router.post('/ignore/:conversationId', ignoreRequest);

// Mark conversation as read
router.post('/mark-read/:conversationId', markConversationRead);

export default router;
