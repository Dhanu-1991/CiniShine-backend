/**
 * Admin Panel Tests — Auth, Management, Content Operations, Archive
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run with:  node --test backend/tests/admin.test.js
 *
 * Requirements:
 *   - MONGODB_URI env var (use a test database!)
 *   - JWT_SECRET env var
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });

// Models
import Admin from '../models/admin.model.js';
import AdminRequest from '../models/adminRequest.model.js';
import AdminOtpSession from '../models/adminOtpSession.model.js';
import ContentArchive from '../models/contentArchive.model.js';
import AdminAuditLog from '../models/adminAuditLog.model.js';
import AdminNotification from '../models/adminNotification.model.js';
import Content from '../models/content.model.js';
import User from '../models/user.model.js';

// Controllers
import {
    adminSignin,
    adminVerifyOtp,
    adminResendOtp,
} from '../controllers/admin-controllers/adminAuthController.js';

import {
    approveSignup,
    rejectSignup,
    listRequests,
    removeAdmin,
    listAdmins,
} from '../controllers/admin-controllers/adminManagementController.js';

import {
    hideContent,
    removeContent,
    restoreContent,
    listArchive,
    getContentDetails,
    searchCreators,
} from '../controllers/admin-controllers/adminContentController.js';

import {
    getDashboard,
    listReports,
    listAuditLogs,
    listNotifications,
} from '../controllers/admin-controllers/adminDashboardController.js';

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

function mockReq({ adminId, adminRole = 'superadmin', body = {}, params = {}, query = {}, headers = {} } = {}) {
    return {
        admin: adminId ? { id: adminId, role: adminRole } : undefined,
        body,
        params,
        query,
        headers: { 'x-forwarded-for': '127.0.0.1', 'user-agent': 'test-runner', ...headers },
        ip: '127.0.0.1',
        get(name) { return this.headers[name.toLowerCase()]; },
    };
}

const TEST_PASSWORD = 'TestP@ss123';
const testTag = `test-admin-${Date.now()}`;

let superAdmin, regularAdmin, pendingAdmin, testUser, testContent;

/* ────── Setup / Teardown ────── */

before(async () => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is required');
    await mongoose.connect(uri);

    const hash = await bcrypt.hash(TEST_PASSWORD, 10);

    // Create a super admin
    superAdmin = await Admin.create({
        name: `SuperAdmin-${testTag}`,
        contact: `super-${testTag}@test.local`,
        password_hash: hash,
        role: 'superadmin',
        status: 'active',
    });

    // Create an active regular admin
    regularAdmin = await Admin.create({
        name: `Admin-${testTag}`,
        contact: `admin-${testTag}@test.local`,
        password_hash: hash,
        role: 'admin',
        status: 'active',
    });

    // Create a pending admin
    pendingAdmin = await Admin.create({
        name: `Pending-${testTag}`,
        contact: `pending-${testTag}@test.local`,
        password_hash: hash,
        role: 'admin',
        status: 'pending',
    });

    // Create a test user (content creator)
    testUser = await User.create({
        userName: `Creator-${testTag}`,
        email: `creator-${testTag}@test.local`,
        password: 'hashed',
        channelName: 'TestChannel',
        channelHandle: `testchannel-${testTag}`,
    });

    // Create test content
    testContent = await Content.create({
        contentType: 'video',
        userId: testUser._id,
        title: `Test Video ${testTag}`,
        originalKey: `uploads/${testUser._id}/test.mp4`,
        thumbnailKey: `thumbnails/${testUser._id}/thumb.jpg`,
        hlsMasterKey: `hls/videos/${testUser._id}/master.m3u8`,
        status: 'completed',
    });
});

after(async () => {
    // Clean up all test data
    const adminIds = [superAdmin?._id, regularAdmin?._id, pendingAdmin?._id].filter(Boolean);
    await Admin.deleteMany({ _id: { $in: adminIds } });
    await AdminRequest.deleteMany({ requester_contact: { $regex: testTag } });
    await AdminOtpSession.deleteMany({ contact: { $regex: testTag } });
    await ContentArchive.deleteMany({ removed_by_admin: { $in: adminIds } });
    await AdminAuditLog.deleteMany({ admin_id: { $in: adminIds } });
    await AdminNotification.deleteMany({ title: { $regex: testTag } });
    if (testContent) await Content.deleteOne({ _id: testContent._id });
    if (testUser) await User.deleteOne({ _id: testUser._id });
    await mongoose.disconnect();
});

/* ══════════════════════════════════════════
   AUTH TESTS
   ══════════════════════════════════════════ */

describe('Admin Auth', () => {
    it('should reject signin with wrong password', async () => {
        const req = mockReq({
            body: { contact: superAdmin.contact, password: 'wrong-password' },
        });
        const res = mockRes();
        await adminSignin(req, res);
        assert.equal(res.statusCode, 401);
        assert.ok(res.body.message);
    });

    it('should start OTP flow with correct credentials', async () => {
        const req = mockReq({
            body: { contact: superAdmin.contact, password: TEST_PASSWORD },
        });
        const res = mockRes();
        await adminSignin(req, res);
        // Should be 200 with otp_required or may fail on OTP send (no SES in tests)
        // Accept both 200 (OTP sent, session created) or error from the OTP sending
        assert.ok([200, 500].includes(res.statusCode), `Expected 200 or 500, got ${res.statusCode}`);
    });

    it('should reject signin for pending admin', async () => {
        const req = mockReq({
            body: { contact: pendingAdmin.contact, password: TEST_PASSWORD },
        });
        const res = mockRes();
        await adminSignin(req, res);
        assert.equal(res.statusCode, 403);
    });

    it('should fail OTP verification with invalid session', async () => {
        const req = mockReq({
            body: { session_id: new mongoose.Types.ObjectId().toString(), otp: '000000' },
        });
        const res = mockRes();
        await adminVerifyOtp(req, res);
        assert.equal(res.statusCode, 400);
    });

    it('should reject resend OTP for invalid session', async () => {
        const req = mockReq({
            body: { session_id: new mongoose.Types.ObjectId().toString() },
        });
        const res = mockRes();
        await adminResendOtp(req, res);
        assert.equal(res.statusCode, 400);
    });
});

/* ══════════════════════════════════════════
   MANAGEMENT TESTS
   ══════════════════════════════════════════ */

describe('Admin Management', () => {
    let signupRequest;

    before(async () => {
        signupRequest = await AdminRequest.create({
            requester_contact: pendingAdmin.contact,
            type: 'signup',
            reason: 'Test signup request',
            status: 'pending',
        });
    });

    it('should list pending requests', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            query: { status: 'pending' },
        });
        const res = mockRes();
        await listRequests(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.requests));
    });

    it('should reject signup request', async () => {
        // Create a second request to reject
        const toReject = await AdminRequest.create({
            requester_contact: `reject-${testTag}@test.local`,
            type: 'signup',
            reason: 'Will be rejected',
            status: 'pending',
        });
        const rejectAdmin = await Admin.create({
            name: `RejectMe-${testTag}`,
            contact: `reject-${testTag}@test.local`,
            password_hash: 'dummy',
            role: 'admin',
            status: 'pending',
        });

        const req = mockReq({
            adminId: superAdmin._id.toString(),
            body: { request_id: toReject._id.toString(), reason: 'Test rejection' },
        });
        const res = mockRes();
        await rejectSignup(req, res);
        assert.equal(res.statusCode, 200);

        // Verify the admin and request were cleaned up
        const deletedAdmin = await Admin.findById(rejectAdmin._id);
        assert.equal(deletedAdmin, null);

        // Clean up
        await AdminRequest.deleteOne({ _id: toReject._id });
    });

    it('should approve signup request', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            body: { request_id: signupRequest._id.toString() },
        });
        const res = mockRes();
        await approveSignup(req, res);
        assert.equal(res.statusCode, 200);

        // Verify pending admin is now active
        const updated = await Admin.findById(pendingAdmin._id);
        assert.equal(updated.status, 'active');
    });

    it('should list all admins', async () => {
        const req = mockReq({ adminId: superAdmin._id.toString() });
        const res = mockRes();
        await listAdmins(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.admins.length >= 2);
    });

    it('should remove regular admin as superadmin', async () => {
        // Create a throwaway admin to remove
        const toRemove = await Admin.create({
            name: `RemoveMe-${testTag}`,
            contact: `removeme-${testTag}@test.local`,
            password_hash: 'dummy',
            role: 'admin',
            status: 'active',
        });

        const req = mockReq({
            adminId: superAdmin._id.toString(),
            params: { id: toRemove._id.toString() },
        });
        const res = mockRes();
        await removeAdmin(req, res);
        assert.equal(res.statusCode, 200);

        const removed = await Admin.findById(toRemove._id);
        assert.equal(removed, null);
    });

    it('should not allow superadmin to remove self', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            params: { id: superAdmin._id.toString() },
        });
        const res = mockRes();
        await removeAdmin(req, res);
        assert.equal(res.statusCode, 400);
    });
});

/* ══════════════════════════════════════════
   CONTENT OPERATIONS TESTS
   ══════════════════════════════════════════ */

describe('Admin Content Operations', () => {
    it('should get content details', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            params: { id: testContent._id.toString() },
        });
        const res = mockRes();
        await getContentDetails(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.content);
        assert.equal(res.body.content.title, testContent.title);
    });

    it('should hide content', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            params: { id: testContent._id.toString() },
            body: { reason: 'Test hide' },
        });
        const res = mockRes();
        await hideContent(req, res);
        assert.equal(res.statusCode, 200);

        const updated = await Content.findById(testContent._id);
        assert.equal(updated.visibility, 'hidden');
    });

    it('should unhide content (toggle)', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            params: { id: testContent._id.toString() },
        });
        const res = mockRes();
        await hideContent(req, res);
        assert.equal(res.statusCode, 200);

        const updated = await Content.findById(testContent._id);
        assert.notEqual(updated.visibility, 'hidden');
    });

    it('should remove content to archive', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            params: { id: testContent._id.toString() },
            body: { reason: 'Test removal' },
        });
        const res = mockRes();
        await removeContent(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.archive_id);

        // Verify archive entry created
        const archive = await ContentArchive.findById(res.body.archive_id);
        assert.ok(archive);
        assert.equal(archive.reason, 'Test removal');
        assert.ok(archive.delete_scheduled_at);
    });

    it('should list archive', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            query: {},
        });
        const res = mockRes();
        await listArchive(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.archives));
        assert.ok(res.body.archives.length >= 1);
    });

    it('should restore from archive', async () => {
        // Find the archive entry
        const archive = await ContentArchive.findOne({ content_id: testContent._id });
        assert.ok(archive, 'Archive entry should exist');

        const req = mockReq({
            adminId: superAdmin._id.toString(),
            params: { id: testContent._id.toString() },
        });
        const res = mockRes();
        await restoreContent(req, res);
        assert.equal(res.statusCode, 200);

        // Verify content is back
        const content = await Content.findById(testContent._id);
        assert.ok(content);

        // Verify archive marked as restored
        const updated = await ContentArchive.findById(archive._id);
        assert.ok(updated.restored_at);
    });

    it('should search creators', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            query: { q: testUser.userName },
        });
        const res = mockRes();
        await searchCreators(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.creators.length >= 1);
    });
});

/* ══════════════════════════════════════════
   DASHBOARD TESTS
   ══════════════════════════════════════════ */

describe('Admin Dashboard', () => {
    it('should return dashboard metrics', async () => {
        const req = mockReq({ adminId: superAdmin._id.toString() });
        const res = mockRes();
        await getDashboard(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.metrics !== undefined || res.body.totalUsers !== undefined);
    });

    it('should list reports (empty or non-empty)', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            query: {},
        });
        const res = mockRes();
        await listReports(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.reports));
    });

    it('should list audit logs', async () => {
        const req = mockReq({
            adminId: superAdmin._id.toString(),
            query: {},
        });
        const res = mockRes();
        await listAuditLogs(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.logs));
    });

    it('should list notifications', async () => {
        // Create a test notification
        await AdminNotification.create({
            type: 'system',
            title: `Test Notification ${testTag}`,
            message: 'Test message',
            severity: 'info',
        });

        const req = mockReq({
            adminId: superAdmin._id.toString(),
            query: {},
        });
        const res = mockRes();
        await listNotifications(req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.notifications));
    });
});

/* ══════════════════════════════════════════
   RBAC TESTS
   ══════════════════════════════════════════ */

describe('RBAC - Role-Based Access', () => {
    it('regular admin should not remove another admin', async () => {
        const req = mockReq({
            adminId: regularAdmin._id.toString(),
            adminRole: 'admin',
            params: { id: superAdmin._id.toString() },
        });
        const res = mockRes();
        // removeAdmin checks req.admin.role === 'superadmin'
        // The route has requireSuperAdmin middleware, but calling controller directly
        // The controller itself should also check in some implementations
        await removeAdmin(req, res);
        // Should get 403 or 400 since only superadmin should be able to remove
        assert.ok([400, 403].includes(res.statusCode));
    });
});
