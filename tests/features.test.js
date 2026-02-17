/**
 * Backend Tests — Bookmark, Chat, Notification systems
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run with:  node --test backend/tests/features.test.js
 *
 * Requirements:
 *   - MONGODB_URI env var (use a test database!)
 *   - JWT_SECRET env var
 *
 * These tests exercise the controller logic by calling the exported
 * functions directly with mock req/res objects (no HTTP server needed).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });

// Models
import User from '../models/user.model.js';
import Content from '../models/content.model.js';
import Bookmark from '../models/bookmark.model.js';
import Conversation from '../models/conversation.model.js';
import Message from '../models/message.model.js';
import Notification from '../models/notification.model.js';

// Controllers
import {
    toggleBookmark,
    getBookmarkStatus,
    getBookmarksByType,
    removeBookmark,
} from '../controllers/bookmark-controllers/bookmarkController.js';

import {
    sendMessage,
    getConversations,
    getRequests,
    acceptRequest,
    getUnreadCount,
} from '../controllers/chat-controllers/chatController.js';

import {
    createUploadNotifications,
    getNotifications,
    dismissNotification,
} from '../controllers/notification-controllers/notificationController.js';

/* ────── Helpers ────── */

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { res.statusCode = code; return res; },
        json(data) { res.body = data; return res; },
    };
    return res;
}

function mockReq(userId, { body = {}, params = {}, query = {} } = {}) {
    return { user: { id: userId }, body, params, query };
}

let creatorUser, subscriberUser, strangerUser, testContent;

/* ────── Setup / Teardown ────── */

before(async () => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is required');
    await mongoose.connect(uri);

    // Clean test data
    const testEmail = (tag) => `test-${tag}-${Date.now()}@test.local`;

    creatorUser = await User.create({
        userName: 'TestCreator',
        email: testEmail('creator'),
        password: 'hashed',
        channelName: 'TestCreatorChannel',
        channelHandle: 'testcreator',
        subscriptions: [],
    });

    subscriberUser = await User.create({
        userName: 'TestSubscriber',
        email: testEmail('subscriber'),
        password: 'hashed',
        subscriptions: [creatorUser._id], // subscribed to creator
    });

    strangerUser = await User.create({
        userName: 'TestStranger',
        email: testEmail('stranger'),
        password: 'hashed',
        subscriptions: [],
    });

    testContent = await Content.create({
        contentType: 'video',
        userId: creatorUser._id,
        title: 'Test Video',
        originalKey: 'test/video.mp4',
        status: 'completed',
    });
});

after(async () => {
    // Clean up test data
    const ids = [creatorUser?._id, subscriberUser?._id, strangerUser?._id].filter(Boolean);
    await User.deleteMany({ _id: { $in: ids } });
    if (testContent) await Content.deleteOne({ _id: testContent._id });
    await Bookmark.deleteMany({ userId: { $in: ids } });
    await Conversation.deleteMany({ participants: { $in: ids } });
    await Message.deleteMany({ $or: [{ senderId: { $in: ids } }, { recipientId: { $in: ids } }] });
    await Notification.deleteMany({ userId: { $in: ids } });
    await mongoose.disconnect();
});

/* ══════════════════════════════════════════
   BOOKMARK TESTS
   ══════════════════════════════════════════ */

describe('Bookmarks', () => {
    it('should toggle bookmark ON', async () => {
        const req = mockReq(subscriberUser._id.toString(), {
            body: { contentId: testContent._id.toString(), contentType: 'video' },
        });
        const res = mockRes();
        await toggleBookmark(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.bookmarked, true);
    });

    it('should report bookmark status as true', async () => {
        const req = mockReq(subscriberUser._id.toString(), {
            params: { contentId: testContent._id.toString() },
        });
        const res = mockRes();
        await getBookmarkStatus(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.isBookmarked, true);
    });

    it('should return bookmarks by type (paginated)', async () => {
        const req = mockReq(subscriberUser._id.toString(), {
            params: { type: 'video' },
            query: { page: '1', limit: '10' },
        });
        const res = mockRes();
        await getBookmarksByType(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.items));
        assert.ok(res.body.items.length >= 1);
    });

    it('should toggle bookmark OFF', async () => {
        const req = mockReq(subscriberUser._id.toString(), {
            body: { contentId: testContent._id.toString(), contentType: 'video' },
        });
        const res = mockRes();
        await toggleBookmark(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.bookmarked, false);
    });

    it('should remove bookmark by contentId', async () => {
        // Create one first
        const reqOn = mockReq(subscriberUser._id.toString(), {
            body: { contentId: testContent._id.toString(), contentType: 'video' },
        });
        await toggleBookmark(reqOn, mockRes());

        const req = mockReq(subscriberUser._id.toString(), {
            params: { contentId: testContent._id.toString() },
        });
        const res = mockRes();
        await removeBookmark(req, res);
        assert.equal(res.statusCode, 200);
    });
});

/* ══════════════════════════════════════════
   CHAT TESTS
   ══════════════════════════════════════════ */

describe('Chat / Messaging', () => {
    it('subscriber message auto-accepts into chats', async () => {
        const req = mockReq(subscriberUser._id.toString(), {
            body: { recipientId: creatorUser._id.toString(), text: 'Hello from subscriber!' },
        });
        const res = mockRes();
        await sendMessage(req, res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.data.isRequest, false);
    });

    it('creator sees conversation in chats list', async () => {
        const req = mockReq(creatorUser._id.toString(), { query: { page: '1', limit: '20' } });
        const res = mockRes();
        await getConversations(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.items.length >= 1);
        const conv = res.body.items.find(c => c.otherUser?._id.toString() === subscriberUser._id.toString());
        assert.ok(conv, 'Should find conversation with subscriber');
    });

    it('non-subscriber message goes to requests', async () => {
        const req = mockReq(strangerUser._id.toString(), {
            body: { recipientId: creatorUser._id.toString(), text: 'Hello from stranger!' },
        });
        const res = mockRes();
        await sendMessage(req, res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.data.isRequest, true);
    });

    it('creator sees request in requests list', async () => {
        const req = mockReq(creatorUser._id.toString(), { query: { page: '1', limit: '20' } });
        const res = mockRes();
        await getRequests(req, res);
        assert.equal(res.statusCode, 200);
        const requestConv = res.body.items.find(
            c => c.otherUser?._id.toString() === strangerUser._id.toString()
        );
        assert.ok(requestConv, 'Should find request from stranger');
    });

    it('creator can accept a request', async () => {
        // Find conversation id for stranger
        const reqList = mockReq(creatorUser._id.toString(), { query: { page: '1', limit: '20' } });
        const resList = mockRes();
        await getRequests(reqList, resList);
        const conv = resList.body.items.find(
            c => c.otherUser?._id.toString() === strangerUser._id.toString()
        );
        assert.ok(conv);

        const req = mockReq(creatorUser._id.toString(), {
            params: { conversationId: conv._id.toString() },
        });
        const res = mockRes();
        await acceptRequest(req, res);
        assert.equal(res.statusCode, 200);
    });

    it('unread count returns correct values', async () => {
        const req = mockReq(creatorUser._id.toString());
        const res = mockRes();
        await getUnreadCount(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(typeof res.body.totalUnread === 'number');
    });
});

/* ══════════════════════════════════════════
   NOTIFICATION TESTS
   ══════════════════════════════════════════ */

describe('Notifications', () => {
    it('createUploadNotifications creates notifications for subscribers', async () => {
        await createUploadNotifications(
            creatorUser._id,
            testContent._id,
            'video',
            'Test Video',
            'test/thumb.jpg'
        );

        // subscriberUser should have a notification
        const notifs = await Notification.find({ userId: subscriberUser._id });
        assert.ok(notifs.length >= 1);
        assert.equal(notifs[0].contentType, 'video');
    });

    it('getNotifications returns paginated list', async () => {
        const req = mockReq(subscriberUser._id.toString(), { query: {} });
        const res = mockRes();
        await getNotifications(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.items));
        assert.ok(res.body.items.length >= 1);
    });

    it('dismissNotification removes a notification', async () => {
        const notif = await Notification.findOne({ userId: subscriberUser._id });
        assert.ok(notif);

        const req = mockReq(subscriberUser._id.toString(), {
            params: { id: notif._id.toString() },
        });
        const res = mockRes();
        await dismissNotification(req, res);
        assert.equal(res.statusCode, 200);

        const remaining = await Notification.findById(notif._id);
        assert.equal(remaining, null);
    });

    it('enforces max 10 notifications per user (FIFO)', async () => {
        // Create 12 content items and notify
        const contentIds = [];
        for (let i = 0; i < 12; i++) {
            const c = await Content.create({
                contentType: 'video',
                userId: creatorUser._id,
                title: `FIFO Test ${i}`,
                originalKey: `test/fifo-${i}.mp4`,
                status: 'completed',
            });
            contentIds.push(c._id);
        }

        for (const cId of contentIds) {
            await createUploadNotifications(
                creatorUser._id, cId, 'video', 'FIFO Test', null
            );
        }

        const count = await Notification.countDocuments({ userId: subscriberUser._id });
        assert.ok(count <= 10, `Expected max 10 notifications, got ${count}`);

        // Cleanup
        await Content.deleteMany({ _id: { $in: contentIds } });
    });
});
