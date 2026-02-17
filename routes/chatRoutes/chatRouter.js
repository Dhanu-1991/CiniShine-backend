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
    searchConversations,
    editMessage,
    deleteMessage,
    // New
    searchCreators,
    hideConversation,
    createGroup,
    acceptGroupInvite,
    leaveGroup,
    sendGroupMessage,
    getGroupMessages,
    makeGroupAdmin,
    editGroupInfo,
    getGroups,
    searchMessages,
    searchGroupMessages
} from '../../controllers/chat-controllers/chatController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// All chat routes require authentication
router.use(universalTokenVerifier);

// Send a DM
router.post('/send', sendMessage);

// Get conversations (accepted chats)
router.get('/conversations', getConversations);

// Get message requests
router.get('/requests', getRequests);

// Search within existing conversations
router.get('/search', searchConversations);

// Global creator search (subscriber-weighted)
router.get('/search-creators', searchCreators);

// Unread count
router.get('/unread-count', getUnreadCount);

// Get DM messages for a conversation
router.get('/conversation/:userId', getConversationMessages);

// Search within a DM conversation
router.get('/conversation/:userId/search', searchMessages);

// Accept a request
router.post('/accept/:conversationId', acceptRequest);

// Ignore/archive a request
router.post('/ignore/:conversationId', ignoreRequest);

// Mark conversation as read
router.post('/mark-read/:conversationId', markConversationRead);

// Edit a message
router.patch('/message/:messageId', editMessage);

// Delete a message
router.delete('/message/:messageId', deleteMessage);

// Hide/soft-delete a conversation from own side
router.delete('/hide/:conversationId', hideConversation);

// ── Group routes ──
router.get('/groups', getGroups);
router.post('/group/create', createGroup);
router.post('/group/:conversationId/accept-invite', acceptGroupInvite);
router.post('/group/:conversationId/leave', leaveGroup);
router.post('/group/:conversationId/send', sendGroupMessage);
router.get('/group/:conversationId/messages', getGroupMessages);
router.get('/group/:conversationId/search', searchGroupMessages);
router.patch('/group/:conversationId/make-admin/:memberId', makeGroupAdmin);
router.patch('/group/:conversationId', editGroupInfo);

export default router;
