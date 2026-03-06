import mongoose from 'mongoose';
import Conversation from '../../models/conversation.model.js';
import Message from '../../models/message.model.js';
import Admin from '../../models/admin.model.js';
import User from '../../models/user.model.js';
import Content from '../../models/content.model.js';
import ContentReport from '../../models/contentReport.model.js';
import AdminAuditLog from '../../models/adminAuditLog.model.js';

/**
 * Admin-to-Creator messaging.
 * 
 * Admin messages appear in the creator's chat section with an "ADMIN" tag.
 * We use the existing Message + Conversation models but mark messages with
 * a special convention: senderId is null, and we store admin info in the
 * message metadata via a virtual admin sender.
 * 
 * To keep it compatible with the existing chat system, we create a
 * placeholder "admin user" concept: we use a fixed ObjectId prefix system
 * so the creator sees it in their conversations.
 * 
 * Actually, simpler approach: We'll create admin conversations using the
 * Conversation model with the admin's _id from Admin model. The frontend
 * chat UI will detect the "isAdminConversation" flag and render the tag.
 */

/**
 * POST /admin/chat/send
 * Send a message from admin to a creator.
 * Creates or resumes a conversation.
 */
export const adminSendMessage = async (req, res) => {
    try {
        const { creator_id, text } = req.body;
        const adminId = req.admin._id;

        if (!creator_id || !text?.trim()) {
            return res.status(400).json({ success: false, message: 'creator_id and text are required' });
        }

        if (!mongoose.Types.ObjectId.isValid(creator_id)) {
            return res.status(400).json({ success: false, message: 'Invalid creator ID' });
        }

        const creator = await User.findById(creator_id);
        if (!creator) {
            return res.status(404).json({ success: false, message: 'Creator not found' });
        }

        // Admin chat is only allowed within report context — verify there's a report on this creator's content
        const creatorContentIds = await Content.find({ userId: creator_id }).distinct('_id');
        const hasReport = await ContentReport.exists({
            contentId: { $in: creatorContentIds },
            status: { $in: ['pending', 'reviewed', 'resolved'] }
        });
        if (!hasReport) {
            return res.status(403).json({
                success: false,
                message: 'Admin chat is only available within the context of a content report for this creator.'
            });
        }

        const admin = await Admin.findById(adminId);
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        // Find or create admin conversation
        // We use a convention: admin conversations have isGroup=false,
        // and store admin ObjectId in initiatorId with a special flag
        let conversation = await Conversation.findOne({
            isAdminConversation: true,
            adminId: adminId,
            creatorId: creator_id
        });

        if (!conversation) {
            conversation = await Conversation.create({
                participants: [creator_id], // only the creator is a "User" participant
                initiatorId: creator_id, // store creator as initiator (for existing queries)
                creatorId: creator_id,
                accepted: true, // admin conversations are always accepted
                isAdminConversation: true,
                adminId: adminId,
                adminName: admin.name,
                lastMessage: {
                    text: text.trim(),
                    senderId: null,
                    createdAt: new Date()
                },
                unreadCount: new Map([[creator_id.toString(), 1]])
            });
        }

        // Create the message
        const message = await Message.create({
            senderId: null, // null indicates admin sender
            recipientId: creator_id,
            text: text.trim(),
            senderIsSubscriber: false,
            accepted: true,
            conversationId: conversation._id,
            isAdminMessage: true,
            adminId: adminId,
            adminName: admin.name
        });

        // Update conversation
        conversation.lastMessage = {
            text: text.trim(),
            senderId: null,
            createdAt: new Date()
        };
        const currentUnread = conversation.unreadCount?.get(creator_id.toString()) || 0;
        conversation.unreadCount.set(creator_id.toString(), currentUnread + 1);
        conversation.updatedAt = new Date();
        await conversation.save();

        await AdminAuditLog.create({
            admin_id: adminId,
            action: 'admin_message_sent',
            target_type: 'user',
            target_id: creator_id,
            ip: req.ip || '',
            user_agent: req.headers['user-agent'] || '',
            note: `Message sent to creator ${creator.userName}`
        });

        return res.status(200).json({
            success: true,
            message: 'Message sent',
            data: {
                conversationId: conversation._id,
                messageId: message._id,
                text: message.text,
                createdAt: message.createdAt
            }
        });
    } catch (error) {
        console.error('Admin send message error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/chat/:creatorId
 * Get admin's conversation messages with a specific creator.
 */
export const adminGetMessages = async (req, res) => {
    try {
        const { creatorId } = req.params;
        const adminId = req.admin._id;
        const { page = 1, limit = 50 } = req.query;

        if (!mongoose.Types.ObjectId.isValid(creatorId)) {
            return res.status(400).json({ success: false, message: 'Invalid creator ID' });
        }

        const conversation = await Conversation.findOne({
            isAdminConversation: true,
            adminId: adminId,
            creatorId: creatorId
        });

        if (!conversation) {
            return res.status(200).json({ success: true, messages: [], conversationId: null });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const messages = await Message.find({
            conversationId: conversation._id,
            deletedForEveryone: { $ne: true }
        })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Mark admin's unread as 0 (admin has read them)
        // N/A since admin doesn't have a userId in the unreadCount map

        return res.status(200).json({
            success: true,
            conversationId: conversation._id,
            messages: messages.reverse() // oldest first for display
        });
    } catch (error) {
        console.error('Admin get messages error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/chat/conversations
 * List all admin's conversations with creators.
 */
export const adminGetConversations = async (req, res) => {
    try {
        const adminId = req.admin._id;

        const conversations = await Conversation.find({
            isAdminConversation: true,
            adminId: adminId
        })
            .sort({ updatedAt: -1 })
            .populate('creatorId', 'userName channelName channelHandle profilePicture')
            .lean();

        return res.status(200).json({
            success: true,
            conversations
        });
    } catch (error) {
        console.error('Admin get conversations error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
