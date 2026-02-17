/**
 * Chat / Messaging Controller
 * 
 * Endpoints:
 * - POST   /api/v2/chats/send                    — Send a message
 * - GET    /api/v2/chats/conversations            — List conversations (chats tab)
 * - GET    /api/v2/chats/requests                 — List message requests
 * - GET    /api/v2/chats/conversation/:userId     — Get messages in a conversation (paginated)
 * - POST   /api/v2/chats/accept/:conversationId   — Accept a request (move to chats)
 * - POST   /api/v2/chats/ignore/:conversationId   — Ignore/archive a request
 * - GET    /api/v2/chats/unread-count             — Get total unread count (chats + requests)
 * - POST   /api/v2/chats/mark-read/:conversationId — Mark all messages in a conversation as read
 * - GET    /api/v2/chats/search?q=handle          — Search conversations by handle name
 */

import Conversation from '../../models/conversation.model.js';
import Message from '../../models/message.model.js';
import User from '../../models/user.model.js';
import mongoose from 'mongoose';

/**
 * Send a message to a creator
 * POST /api/v2/chats/send
 * Body: { recipientId, text }
 */
export const sendMessage = async (req, res) => {
    try {
        const senderId = req.user.id;
        const { recipientId, text } = req.body;

        if (!recipientId || !text?.trim()) {
            return res.status(400).json({ message: 'recipientId and text are required' });
        }

        if (senderId === recipientId) {
            return res.status(400).json({ message: 'Cannot send a message to yourself' });
        }

        // Check if recipient exists
        const recipient = await User.findById(recipientId);
        if (!recipient) {
            return res.status(404).json({ message: 'Recipient not found' });
        }

        // Check if sender is subscribed to recipient
        const sender = await User.findById(senderId);
        const isSubscriber = sender.subscriptions?.some(
            subId => subId.toString() === recipientId
        );

        // Find or create conversation
        const sortedParticipants = [senderId, recipientId].sort();
        let conversation = await Conversation.findOne({
            participants: { $all: sortedParticipants, $size: 2 }
        });

        if (!conversation) {
            conversation = await Conversation.create({
                participants: sortedParticipants,
                initiatorId: senderId,
                creatorId: recipientId,
                initiatorIsSubscriber: isSubscriber,
                accepted: isSubscriber, // Auto-accept if subscriber
                lastMessage: {
                    text: text.trim(),
                    senderId,
                    createdAt: new Date()
                },
                unreadCount: new Map([[recipientId, 1]])
            });
        } else {
            // Update last message
            const currentUnread = conversation.unreadCount?.get(recipientId) || 0;
            conversation.lastMessage = {
                text: text.trim(),
                senderId,
                createdAt: new Date()
            };
            conversation.unreadCount.set(recipientId, currentUnread + 1);
            conversation.updatedAt = new Date();

            // If previously archived and sender is messaging again, un-archive
            if (conversation.archived && conversation.initiatorId.toString() === senderId) {
                conversation.archived = false;
            }

            await conversation.save();
        }

        // Create the message
        const message = await Message.create({
            senderId,
            recipientId,
            text: text.trim(),
            senderIsSubscriber: isSubscriber,
            accepted: conversation.accepted
        });

        return res.status(201).json({
            message: 'Message sent',
            data: {
                messageId: message._id,
                conversationId: conversation._id,
                isRequest: !conversation.accepted,
                text: message.text,
                createdAt: message.createdAt
            }
        });
    } catch (error) {
        console.error('Error sending message:', error);
        return res.status(500).json({ message: 'Failed to send message' });
    }
};

/**
 * Get conversations (chats tab — accepted conversations)
 * GET /api/v2/chats/conversations?page=1&limit=20
 */
export const getConversations = async (req, res) => {
    try {
        const userId = req.user.id;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;

        const filter = {
            participants: new mongoose.Types.ObjectId(userId),
            $or: [
                { accepted: true },
                { initiatorId: new mongoose.Types.ObjectId(userId) } // Initiator always sees their conversations
            ],
            archived: { $ne: true }
        };

        const [conversations, total] = await Promise.all([
            Conversation.find(filter)
                .sort({ updatedAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('participants', 'userName channelName channelHandle channelPicture profilePicture')
                .lean(),
            Conversation.countDocuments(filter)
        ]);

        // Map conversations to include other user info
        const items = conversations.map(conv => {
            const otherUser = conv.participants.find(
                p => p._id.toString() !== userId
            );
            return {
                _id: conv._id,
                otherUser: otherUser ? {
                    _id: otherUser._id,
                    userName: otherUser.userName,
                    channelName: otherUser.channelName,
                    channelHandle: otherUser.channelHandle,
                    channelPicture: otherUser.channelPicture,
                    profilePicture: otherUser.profilePicture
                } : null,
                lastMessage: conv.lastMessage,
                unreadCount: conv.unreadCount?.get?.(userId) || (conv.unreadCount?.[userId]) || 0,
                accepted: conv.accepted,
                updatedAt: conv.updatedAt,
                createdAt: conv.createdAt
            };
        });

        return res.json({
            items,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore: skip + items.length < total
        });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        return res.status(500).json({ message: 'Failed to fetch conversations' });
    }
};

/**
 * Get message requests (for creators — unaccepted conversations)
 * GET /api/v2/chats/requests?page=1&limit=20
 */
export const getRequests = async (req, res) => {
    try {
        const userId = req.user.id;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;

        const filter = {
            creatorId: new mongoose.Types.ObjectId(userId),
            accepted: false,
            archived: false
        };

        const [conversations, total] = await Promise.all([
            Conversation.find(filter)
                .sort({ updatedAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('participants', 'userName channelName channelHandle channelPicture profilePicture')
                .lean(),
            Conversation.countDocuments(filter)
        ]);

        const items = conversations.map(conv => {
            const otherUser = conv.participants.find(
                p => p._id.toString() !== userId
            );
            return {
                _id: conv._id,
                otherUser: otherUser ? {
                    _id: otherUser._id,
                    userName: otherUser.userName,
                    channelName: otherUser.channelName,
                    channelHandle: otherUser.channelHandle,
                    channelPicture: otherUser.channelPicture,
                    profilePicture: otherUser.profilePicture
                } : null,
                lastMessage: conv.lastMessage,
                unreadCount: conv.unreadCount?.get?.(userId) || (conv.unreadCount?.[userId]) || 0,
                createdAt: conv.createdAt
            };
        });

        return res.json({
            items,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore: skip + items.length < total
        });
    } catch (error) {
        console.error('Error fetching requests:', error);
        return res.status(500).json({ message: 'Failed to fetch requests' });
    }
};

/**
 * Get messages in a conversation (paginated, newest first)
 * GET /api/v2/chats/conversation/:userId?page=1&limit=30
 */
export const getConversationMessages = async (req, res) => {
    try {
        const currentUserId = req.user.id;
        const { userId: otherUserId } = req.params;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
        const skip = (page - 1) * limit;

        // Find conversation
        const sortedParticipants = [currentUserId, otherUserId].sort();
        const conversation = await Conversation.findOne({
            participants: { $all: sortedParticipants, $size: 2 }
        });

        if (!conversation) {
            return res.json({ items: [], page, limit, total: 0, hasMore: false });
        }

        const messageFilter = {
            $or: [
                { senderId: currentUserId, recipientId: otherUserId },
                { senderId: otherUserId, recipientId: currentUserId }
            ]
        };

        const [messages, total] = await Promise.all([
            Message.find(messageFilter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Message.countDocuments(messageFilter)
        ]);

        return res.json({
            items: messages.reverse(), // Return in chronological order
            conversationId: conversation._id,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore: skip + messages.length < total
        });
    } catch (error) {
        console.error('Error fetching messages:', error);
        return res.status(500).json({ message: 'Failed to fetch messages' });
    }
};

/**
 * Accept a message request (move conversation to chats)
 * POST /api/v2/chats/accept/:conversationId
 */
export const acceptRequest = async (req, res) => {
    try {
        const userId = req.user.id;
        const { conversationId } = req.params;

        const conversation = await Conversation.findOne({
            _id: conversationId,
            creatorId: userId,
            accepted: false
        });

        if (!conversation) {
            return res.status(404).json({ message: 'Request not found' });
        }

        conversation.accepted = true;
        conversation.archived = false;
        await conversation.save();

        // Also mark all messages in this conversation as accepted
        await Message.updateMany(
            {
                $or: [
                    { senderId: conversation.initiatorId, recipientId: userId },
                    { senderId: userId, recipientId: conversation.initiatorId }
                ]
            },
            { accepted: true }
        );

        return res.json({ message: 'Request accepted', conversationId });
    } catch (error) {
        console.error('Error accepting request:', error);
        return res.status(500).json({ message: 'Failed to accept request' });
    }
};

/**
 * Ignore/archive a message request
 * POST /api/v2/chats/ignore/:conversationId
 */
export const ignoreRequest = async (req, res) => {
    try {
        const userId = req.user.id;
        const { conversationId } = req.params;

        const conversation = await Conversation.findOne({
            _id: conversationId,
            creatorId: userId
        });

        if (!conversation) {
            return res.status(404).json({ message: 'Request not found' });
        }

        conversation.archived = true;
        await conversation.save();

        return res.json({ message: 'Request ignored', conversationId });
    } catch (error) {
        console.error('Error ignoring request:', error);
        return res.status(500).json({ message: 'Failed to ignore request' });
    }
};

/**
 * Get total unread count across chats and requests
 * GET /api/v2/chats/unread-count
 */
export const getUnreadCount = async (req, res) => {
    try {
        const userId = req.user.id;

        // Get all conversations where user is a participant
        const conversations = await Conversation.find({
            participants: new mongoose.Types.ObjectId(userId),
            archived: false
        }).lean();

        let chatsUnread = 0;
        let requestsUnread = 0;

        conversations.forEach(conv => {
            const unread = conv.unreadCount?.get?.(userId) || (conv.unreadCount?.[userId]) || 0;
            if (conv.accepted || conv.initiatorId?.toString() === userId) {
                chatsUnread += unread;
            } else {
                requestsUnread += unread;
            }
        });

        return res.json({
            chatsUnread,
            requestsUnread,
            totalUnread: chatsUnread + requestsUnread
        });
    } catch (error) {
        console.error('Error fetching unread count:', error);
        return res.status(500).json({ message: 'Failed to fetch unread count' });
    }
};

/**
 * Mark all messages in a conversation as read
 * POST /api/v2/chats/mark-read/:conversationId
 */
export const markConversationRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const { conversationId } = req.params;

        const conversation = await Conversation.findOne({
            _id: conversationId,
            participants: new mongoose.Types.ObjectId(userId)
        });

        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        // Reset unread count for this user
        conversation.unreadCount.set(userId, 0);
        await conversation.save();

        // Mark all messages from other user as read
        const otherUserId = conversation.participants.find(
            p => p.toString() !== userId
        );

        await Message.updateMany(
            { senderId: otherUserId, recipientId: userId, read: false },
            { read: true }
        );

        return res.json({ message: 'Conversation marked as read' });
    } catch (error) {
        console.error('Error marking conversation as read:', error);
        return res.status(500).json({ message: 'Failed to mark as read' });
    }
};

/**
 * Edit a sent message (sender only)
 * PATCH /api/v2/chats/message/:messageId
 * Body: { text }
 */
export const editMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const { messageId } = req.params;
        const { text } = req.body;

        if (!text?.trim()) {
            return res.status(400).json({ message: 'Text is required' });
        }
        if (!mongoose.Types.ObjectId.isValid(messageId)) {
            return res.status(400).json({ message: 'Invalid message ID' });
        }

        const message = await Message.findOne({
            _id: messageId,
            senderId: new mongoose.Types.ObjectId(userId)
        });
        if (!message) {
            return res.status(404).json({ message: 'Message not found or not yours' });
        }

        message.text = text.trim();
        message.editedAt = new Date();
        await message.save();

        return res.json({
            message: 'Message edited',
            data: { _id: message._id, text: message.text, editedAt: message.editedAt }
        });
    } catch (error) {
        console.error('Error editing message:', error);
        return res.status(500).json({ message: 'Failed to edit message' });
    }
};

/**
 * Delete a sent message (sender only)
 * DELETE /api/v2/chats/message/:messageId
 */
export const deleteMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const { messageId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(messageId)) {
            return res.status(400).json({ message: 'Invalid message ID' });
        }

        const message = await Message.findOne({
            _id: messageId,
            senderId: new mongoose.Types.ObjectId(userId)
        });
        if (!message) {
            return res.status(404).json({ message: 'Message not found or not yours' });
        }

        await message.deleteOne();

        // If this was the lastMessage in the conversation, update it
        const conversation = await Conversation.findOne({
            participants: { $all: [message.senderId, message.recipientId] }
        });
        if (conversation && conversation.lastMessage?.text === message.text) {
            // Fetch the previous message
            const prev = await Message.findOne({
                $or: [
                    { senderId: message.senderId, recipientId: message.recipientId },
                    { senderId: message.recipientId, recipientId: message.senderId }
                ]
            }).sort({ createdAt: -1 });
            if (prev) {
                conversation.lastMessage = { text: prev.text, senderId: prev.senderId, createdAt: prev.createdAt };
            } else {
                conversation.lastMessage = null;
            }
            await conversation.save();
        }

        return res.json({ message: 'Message deleted', messageId });
    } catch (error) {
        console.error('Error deleting message:', error);
        return res.status(500).json({ message: 'Failed to delete message' });
    }
};

/**
 * Search conversations by handle name
 * GET /api/v2/chats/search?q=handle
 */
export const searchConversations = async (req, res) => {
    try {
        const userId = req.user.id;
        const query = req.query.q?.trim();

        if (!query) {
            return res.json({ items: [] });
        }

        // Find users matching the search query
        const matchingUsers = await User.find({
            $or: [
                { channelHandle: { $regex: query, $options: 'i' } },
                { channelName: { $regex: query, $options: 'i' } },
                { userName: { $regex: query, $options: 'i' } }
            ]
        }).select('_id').lean();

        const matchingUserIds = matchingUsers.map(u => u._id);

        // Find conversations with these users
        const conversations = await Conversation.find({
            participants: {
                $all: [new mongoose.Types.ObjectId(userId)],
            },
            'participants': { $in: matchingUserIds },
            archived: false
        })
            .sort({ updatedAt: -1 })
            .limit(20)
            .populate('participants', 'userName channelName channelHandle channelPicture profilePicture')
            .lean();

        const items = conversations.map(conv => {
            const otherUser = conv.participants.find(
                p => p._id.toString() !== userId
            );
            return {
                _id: conv._id,
                otherUser: otherUser ? {
                    _id: otherUser._id,
                    userName: otherUser.userName,
                    channelName: otherUser.channelName,
                    channelHandle: otherUser.channelHandle,
                    channelPicture: otherUser.channelPicture,
                    profilePicture: otherUser.profilePicture
                } : null,
                lastMessage: conv.lastMessage,
                unreadCount: conv.unreadCount?.get?.(userId) || (conv.unreadCount?.[userId]) || 0,
                accepted: conv.accepted,
                updatedAt: conv.updatedAt
            };
        });

        return res.json({ items });
    } catch (error) {
        console.error('Error searching conversations:', error);
        return res.status(500).json({ message: 'Failed to search conversations' });
    }
};
