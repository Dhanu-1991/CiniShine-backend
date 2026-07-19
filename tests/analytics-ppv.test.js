/**
 * Analytics & Pay Per View Tests
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run with:  node --test tests/analytics-ppv.test.js
 *
 * Requires MONGO_URI (or MONGODB_URI) env var pointing at a test database.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Same dotenv path pattern as existing features.test.js
dotenv.config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });

// Models
import User from '../models/user.model.js';
import Content from '../models/content.model.js';
import ContentView from '../models/contentView.model.js';
import ContentWatchtime from '../models/contentWatchtime.model.js';
import Purchase from '../models/purchase.model.js';

// Utilities / Controllers
import { recordWatchSignal } from '../utils/watchAnalytics.js';
import { checkAccess, getUserPurchases } from '../controllers/payment-gateway-controllers/purchaseController.js';

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

function mockReq(overrides = {}) {
    return {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'test-agent', 'x-forwarded-for': '127.0.0.1' },
        get: (h) => ({ 'User-Agent': 'test-agent', 'Accept-Language': 'en' }[h] || ''),
        user: null,
        params: {},
        query: {},
        body: {},
        ...overrides,
    };
}

// Unique tag per test run to avoid collisions on the shared DB
const RUN_TAG = Date.now();

let testUser, testCreator, testVideo, testPPVContent;

/* ════════════════════════════════════════════════════════════
   SETUP / TEARDOWN
   ════════════════════════════════════════════════════════════ */

before(async () => {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGO_URI env var required — check backend/.env');
    await mongoose.connect(uri);

    // Wipe previous test documents so we start clean
    await User.deleteMany({ userName: { $in: [`__viewer_${RUN_TAG}`, `__creator_${RUN_TAG}`] } });
    await Content.deleteMany({ title: { $regex: `^__test_` } });
    await Purchase.deleteMany({ orderId: { $regex: `^ORDER_TEST_` } });

    // User model required fields: contact (unique), userName, password
    testCreator = await User.create({
        contact: `creator_${RUN_TAG}@test.local`,
        userName: `__creator_${RUN_TAG}`,
        password: 'hashed_password_irrelevant',
    });

    testUser = await User.create({
        contact: `viewer_${RUN_TAG}@test.local`,
        userName: `__viewer_${RUN_TAG}`,
        password: 'hashed_password_irrelevant',
    });

    testVideo = await Content.create({
        title: `__test_video_${RUN_TAG}`,
        contentType: 'video',
        userId: testCreator._id,
        status: 'completed',
        visibility: 'public',
        duration: 120,
        videoUrl: 'https://example.com/test.mp4',
    });

    testPPVContent = await Content.create({
        title: `__test_ppv_${RUN_TAG}`,
        contentType: 'video',
        userId: testCreator._id,
        status: 'completed',
        visibility: 'pay_per_view',
        price: 49,
        duration: 300,
        videoUrl: 'https://example.com/ppv.mp4',
    });
});

after(async () => {
    await ContentWatchtime.deleteMany({ contentId: { $in: [testVideo?._id, testPPVContent?._id] } });
    await ContentView.deleteMany({ contentId: { $in: [testVideo?._id, testPPVContent?._id] } });
    await Purchase.deleteMany({ orderId: { $regex: `^ORDER_TEST_` } });
    await Content.deleteMany({ title: { $regex: `^__test_` } });
    await User.deleteMany({ userName: { $in: [`__viewer_${RUN_TAG}`, `__creator_${RUN_TAG}`] } });
    await mongoose.disconnect();
});

/* ════════════════════════════════════════════════════════════
   PART 1 — ANALYTICS: watchAnalytics.js / recordWatchSignal
   ════════════════════════════════════════════════════════════ */

describe('watchAnalytics — recordWatchSignal', () => {

    // Reset content counters between each analytics test
    beforeEach(async () => {
        await Content.updateOne({ _id: testVideo._id }, {
            $set: {
                views: 0,
                authenticatedViews: 0,
                anonymousViews: 0,
                authenticatedUniqueViewers: 0,
                anonymousUniqueViewers: 0,
                totalWatchTime: 0,
                completionSumPercent: 0,
                completionSessionCount: 0,
                completionRate: null,
                furthestPlayheadSeconds: 0,
            },
        });
        await ContentView.deleteMany({ contentId: testVideo._id });
        await ContentWatchtime.deleteMany({ contentId: testVideo._id });
    });

    it('heartbeat below threshold: creates event but does NOT count view', async () => {
        const req = mockReq({ user: { id: testUser._id.toString() } });
        const event = {
            eventId: `hb-${RUN_TAG}-${Math.random()}`,
            eventType: 'heartbeat',
            contentId: testVideo._id.toString(),
            activePlayTime: 5,           // well below 30s threshold
            playheadSeconds: 5,
            contentDuration: 120,
            watchSessionId: `ws-hb-${RUN_TAG}`,
            anonymousViewerId: null,
            sessionId: `sess-hb-${RUN_TAG}`,
        };

        const result = await recordWatchSignal({ req, contentId: testVideo._id.toString(), event });

        assert.equal(result.success, true);
        assert.equal(result.duplicate, false);
        assert.equal(result.viewCounted, false,
            'Short heartbeat must NOT count a view');

        const wt = await ContentWatchtime.findOne({ eventId: event.eventId });
        assert.ok(wt, 'ContentWatchtime row must be created');
        assert.equal(wt.activePlayTime, 5);
    });

    it('play exceeds threshold: view is counted and split counter incremented', async () => {
        const req = mockReq({ user: { id: testUser._id.toString() } });
        const wsId = `ws-view-${RUN_TAG}-${Math.random()}`;
        const event = {
            eventId: `view-${RUN_TAG}-${Math.random()}`,
            eventType: 'heartbeat',
            contentId: testVideo._id.toString(),
            activePlayTime: 40,          // > 30s threshold for 120s video
            playheadSeconds: 40,
            contentDuration: 120,
            watchSessionId: wsId,
            anonymousViewerId: null,
            sessionId: `sess-view-${RUN_TAG}`,
        };

        const result = await recordWatchSignal({ req, contentId: testVideo._id.toString(), event });

        assert.equal(result.viewCounted, true, 'View must be counted');
        assert.equal(result.content.views, 1);
        assert.equal(result.content.authenticatedViews, 1);
        assert.equal(result.content.authenticatedUniqueViewers, 1);
        assert.equal(result.content.anonymousViews, 0);
    });

    it('same watchSessionId sent twice: only first counts (atomic dedup)', async () => {
        const req = mockReq({ user: { id: testUser._id.toString() } });
        const wsId = `ws-dedup-${RUN_TAG}-${Math.random()}`;

        const base = {
            eventType: 'heartbeat',
            contentId: testVideo._id.toString(),
            activePlayTime: 35,
            playheadSeconds: 35,
            contentDuration: 120,
            watchSessionId: wsId,
            anonymousViewerId: null,
            sessionId: `sess-dedup-${RUN_TAG}`,
        };

        const r1 = await recordWatchSignal({
            req,
            contentId: testVideo._id.toString(),
            event: { ...base, eventId: `dup-a-${RUN_TAG}-${Math.random()}` }
        });
        const r2 = await recordWatchSignal({
            req,
            contentId: testVideo._id.toString(),
            event: { ...base, eventId: `dup-b-${RUN_TAG}-${Math.random()}` }
        });

        assert.equal(r1.viewCounted, true,  'First call must count');
        assert.equal(r2.viewCounted, false, 'Second call with same session must NOT count');

        const content = await Content.findById(testVideo._id).lean();
        assert.equal(content.views, 1, 'Exactly 1 view must be recorded');
    });

    it('anonymous views counted separately from authenticated', async () => {
        const req = mockReq({ user: null });
        const anonId = `anon-${RUN_TAG}-${Math.random()}`;
        const event = {
            eventId: `anon-${RUN_TAG}-${Math.random()}`,
            eventType: 'heartbeat',
            contentId: testVideo._id.toString(),
            activePlayTime: 35,
            playheadSeconds: 35,
            contentDuration: 120,
            watchSessionId: `ws-anon-${RUN_TAG}-${Math.random()}`,
            anonymousViewerId: anonId,
            sessionId: `sess-anon-${RUN_TAG}`,
        };

        const result = await recordWatchSignal({ req, contentId: testVideo._id.toString(), event });

        assert.equal(result.viewCounted, true);
        assert.equal(result.content.anonymousViews, 1);
        assert.equal(result.content.anonymousUniqueViewers, 1);
        assert.equal(result.content.authenticatedViews, 0);
    });

    it('running average: completionSumPercent/Count only incremented on session end', async () => {
        const req = mockReq({ user: { id: testUser._id.toString() } });

        // Session 1 = 50% (60 of 120 s)
        await recordWatchSignal({
            req,
            contentId: testVideo._id.toString(),
            event: {
                eventId: `comp1-${RUN_TAG}-${Math.random()}`,
                eventType: 'ended',
                contentId: testVideo._id.toString(),
                activePlayTime: 60,
                playheadSeconds: 60,
                contentDuration: 120,
                watchSessionId: `ws-c1-${RUN_TAG}-${Math.random()}`,
                sessionId: `sess-c1-${RUN_TAG}`,
            }
        });

        // Session 2 = 100% (120 of 120 s)
        await recordWatchSignal({
            req,
            contentId: testVideo._id.toString(),
            event: {
                eventId: `comp2-${RUN_TAG}-${Math.random()}`,
                eventType: 'ended',
                contentId: testVideo._id.toString(),
                activePlayTime: 120,
                playheadSeconds: 120,
                contentDuration: 120,
                watchSessionId: `ws-c2-${RUN_TAG}-${Math.random()}`,
                sessionId: `sess-c2-${RUN_TAG}`,
            }
        });

        const content = await Content.findById(testVideo._id).lean();
        assert.equal(content.completionSessionCount, 2, 'Two ended sessions → count = 2');
        assert.ok(content.completionSumPercent > 0, 'Sum must be positive');

        const avg = Math.round(content.completionSumPercent / content.completionSessionCount);
        assert.ok(avg >= 74 && avg <= 76,
            `Average completion should be ~75 (got ${avg})`);
    });

    it('heartbeat does NOT increment completionSessionCount', async () => {
        const req = mockReq({ user: { id: testUser._id.toString() } });

        await recordWatchSignal({
            req,
            contentId: testVideo._id.toString(),
            event: {
                eventId: `hb-ncomp-${RUN_TAG}-${Math.random()}`,
                eventType: 'heartbeat',          // NOT a session end
                contentId: testVideo._id.toString(),
                activePlayTime: 30,
                playheadSeconds: 30,
                contentDuration: 120,
                watchSessionId: `ws-hbnc-${RUN_TAG}-${Math.random()}`,
                sessionId: `sess-hbnc-${RUN_TAG}`,
            }
        });

        const content = await Content.findById(testVideo._id).lean();
        assert.equal(content.completionSessionCount, 0,
            'Heartbeat must not increment completionSessionCount');
    });

    it('duplicate eventId rejected (idempotency)', async () => {
        const req = mockReq({ user: { id: testUser._id.toString() } });
        const eventId = `idem-${RUN_TAG}-${Math.random()}`;
        const base = {
            eventId,
            eventType: 'heartbeat',
            contentId: testVideo._id.toString(),
            activePlayTime: 10,
            playheadSeconds: 10,
            contentDuration: 120,
            watchSessionId: `ws-idem-${RUN_TAG}`,
            sessionId: `sess-idem-${RUN_TAG}`,
        };

        const r1 = await recordWatchSignal({ req, contentId: testVideo._id.toString(), event: base });
        const r2 = await recordWatchSignal({ req, contentId: testVideo._id.toString(), event: base });   // same eventId

        assert.equal(r1.duplicate, false);
        assert.equal(r2.duplicate, true, 'Second call with same eventId must be a duplicate');
    });

    it('short loopCount tracked in content aggregates', async () => {
        const shortContent = await Content.create({
            title: `__test_short_${RUN_TAG}`,
            contentType: 'short',
            userId: testCreator._id,
            status: 'completed',
            visibility: 'public',
            duration: 15,
            videoUrl: 'https://example.com/short.mp4',
        });

        const req = mockReq({ user: { id: testUser._id.toString() } });
        await recordWatchSignal({
            req,
            contentId: shortContent._id.toString(),
            event: {
                eventId: `short-${RUN_TAG}-${Math.random()}`,
                eventType: 'ended',
                contentId: shortContent._id.toString(),
                activePlayTime: 45,    // 3 loops × 15 s
                playheadSeconds: 15,
                contentDuration: 15,
                watchSessionId: `ws-short-${RUN_TAG}`,
                sessionId: `sess-short-${RUN_TAG}`,
                loopCount: 3,
                swipedAway: true,
                swipeAwayAt: 12,
            }
        });

        const updated = await Content.findById(shortContent._id).lean();
        assert.equal(updated.loopCount, 3, 'loopCount should be 3');
        assert.equal(updated.swipeAwayCount, 1, 'swipeAwayCount should be 1');

        await ContentWatchtime.deleteMany({ contentId: shortContent._id });
        await ContentView.deleteMany({ contentId: shortContent._id });
        await Content.deleteOne({ _id: shortContent._id });
    });
});

/* ════════════════════════════════════════════════════════════
   PART 2 — PAY PER VIEW: Content model
   ════════════════════════════════════════════════════════════ */

describe('Pay Per View — Content model', () => {

    it('pay_per_view visibility and price field persisted correctly', async () => {
        const c = await Content.findById(testPPVContent._id).lean();
        assert.equal(c.visibility, 'pay_per_view');
        assert.equal(c.price, 49);
    });

    it('PPV content appears in feed query (visibility $in)', async () => {
        const results = await Content.find({
            status: 'completed',
            visibility: { $in: ['public', 'pay_per_view'] },
            _id: { $in: [testVideo._id, testPPVContent._id] },
        }).lean();

        assert.equal(results.length, 2, 'Both public and PPV content must appear');
        const ids = results.map(r => r._id.toString());
        assert.ok(ids.includes(testPPVContent._id.toString()),
            'PPV content must be in feed results');
    });

    it('PPV content excluded from strict public-only query', async () => {
        const results = await Content.find({
            status: 'completed',
            visibility: 'public',
            _id: testPPVContent._id,
        }).lean();
        assert.equal(results.length, 0,
            'PPV content must NOT appear in strict public-only query');
    });

    it('content model has completionSumPercent and completionSessionCount fields', async () => {
        const c = await Content.findById(testVideo._id).lean();
        assert.ok('completionSumPercent' in c, 'completionSumPercent missing');
        assert.ok('completionSessionCount' in c, 'completionSessionCount missing');
    });

    it('content model has all content-type specific metric fields', async () => {
        const c = await Content.findById(testVideo._id).lean();
        for (const field of ['loopCount', 'swipeAwayCount', 'skipCount', 'replayCount', 'impressions', 'clickThroughCount']) {
            assert.ok(field in c, `Missing field: ${field}`);
        }
    });
});

/* ════════════════════════════════════════════════════════════
   PART 2 — PAY PER VIEW: Purchase system
   ════════════════════════════════════════════════════════════ */

describe('Pay Per View — Purchase system', () => {

    it('checkAccess: no purchase → hasAccess false', async () => {
        const req = mockReq({
            user: { id: testUser._id.toString() },
            params: { contentId: testPPVContent._id.toString() },
        });
        const res = mockRes();

        await checkAccess(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.hasAccess, false);
    });

    it('checkAccess: valid active purchase → hasAccess true', async () => {
        const purchase = await Purchase.create({
            contentId: testPPVContent._id,
            buyerId: testUser._id,
            orderId: `ORDER_TEST_VALID_${RUN_TAG}`,
            paymentId: `PAY_VALID_${RUN_TAG}`,
            amount: 49,
            purchasedAt: new Date(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
            status: 'active',
        });

        const req = mockReq({
            user: { id: testUser._id.toString() },
            params: { contentId: testPPVContent._id.toString() },
        });
        const res = mockRes();

        await checkAccess(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.hasAccess, true,
            'Active purchase must grant access');
        assert.ok(res.body.purchase, 'Purchase object must be returned');

        await Purchase.deleteOne({ _id: purchase._id });
    });

    it('checkAccess: expired purchase → hasAccess false', async () => {
        const purchase = await Purchase.create({
            contentId: testPPVContent._id,
            buyerId: testUser._id,
            orderId: `ORDER_TEST_EXPIRED_${RUN_TAG}`,
            paymentId: `PAY_EXP_${RUN_TAG}`,
            amount: 49,
            purchasedAt: new Date(Date.now() - 72 * 3600 * 1000),
            expiresAt: new Date(Date.now() - 24 * 3600 * 1000),  // expired yesterday
            status: 'active',
        });

        const req = mockReq({
            user: { id: testUser._id.toString() },
            params: { contentId: testPPVContent._id.toString() },
        });
        const res = mockRes();

        await checkAccess(req, res);

        assert.equal(res.body.hasAccess, false,
            'Expired purchase must NOT grant access');

        await Purchase.deleteOne({ _id: purchase._id });
    });

    it('getUserPurchases: returns array with active purchase', async () => {
        const purchase = await Purchase.create({
            contentId: testPPVContent._id,
            buyerId: testUser._id,
            orderId: `ORDER_TEST_LIST_${RUN_TAG}`,
            paymentId: `PAY_LIST_${RUN_TAG}`,
            amount: 49,
            purchasedAt: new Date(),
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
            status: 'active',
        });

        const req = mockReq({ user: { id: testUser._id.toString() } });
        const res = mockRes();

        await getUserPurchases(req, res);

        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.purchases),
            'purchases must be an array');
        assert.ok(res.body.purchases.length >= 1,
            'Must contain at least the created purchase');

        await Purchase.deleteOne({ _id: purchase._id });
    });

    it('Purchase.orderId unique index enforced (E11000)', async () => {
        const orderId = `ORDER_TEST_UNIQUE_${RUN_TAG}`;
        await Purchase.create({
            contentId: testPPVContent._id,
            buyerId: testUser._id,
            orderId,
            amount: 49,
            expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
            status: 'active',
        });

        await assert.rejects(
            () => Purchase.create({
                contentId: testPPVContent._id,
                buyerId: testUser._id,
                orderId,   // same orderId — must fail
                amount: 49,
                expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
                status: 'active',
            }),
            (err) => {
                assert.equal(err.code, 11000, `Expected E11000, got ${err.code}`);
                return true;
            },
        );

        await Purchase.deleteMany({ orderId });
    });
});
