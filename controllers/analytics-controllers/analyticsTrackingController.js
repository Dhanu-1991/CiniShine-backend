import PageUsage from '../../models/pageUsage.model.js';
import ContentWatchtime from '../../models/contentWatchtime.model.js';
import UserSession from '../../models/userSession.model.js';
import Content from '../../models/content.model.js';
import { recordWatchSignal } from '../../utils/watchAnalytics.js';

/**
 * Helper: get date/month bucket strings for current time
 */
function getBuckets(date = new Date()) {
    const d = date.toISOString().slice(0, 10); // "2025-01-15"
    const m = date.toISOString().slice(0, 7);  // "2025-01"
    return { dateBucket: d, monthBucket: m };
}

/**
 * Helper: detect device type from user-agent
 */
function getDevice(ua = '') {
    ua = ua.toLowerCase();
    if (/tablet|ipad/i.test(ua)) return 'tablet';
    if (/mobile|android|iphone/i.test(ua)) return 'mobile';
    return 'desktop';
}

// ─── SESSION MANAGEMENT ──────────────────────────────────────────────────────

/**
 * POST /api/v2/analytics/session/start
 * Start a new session. Returns sessionId.
 */
export const startSession = async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({ success: false, message: 'sessionId required' });
        }

        const { dateBucket, monthBucket } = getBuckets();
        const device = getDevice(req.headers['user-agent']);

        await UserSession.findOneAndUpdate(
            { sessionId },
            {
                $setOnInsert: {
                    sessionId,
                    userId: req.user?.id || null,
                    isAuthenticated: !!req.user?.id,
                    startedAt: new Date(),
                    device,
                    userAgent: (req.headers['user-agent'] || '').slice(0, 300),
                    dateBucket,
                    monthBucket,
                },
                $set: { lastActiveAt: new Date() },
            },
            { upsert: true, new: true }
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('startSession error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /api/v2/analytics/session/heartbeat
 * Keep session alive and update duration.
 */
export const sessionHeartbeat = async (req, res) => {
    try {
        const { sessionId, activeDuration } = req.body;
        if (!sessionId) {
            return res.status(400).json({ success: false, message: 'sessionId required' });
        }

        // Validate duration (max 1 hour per heartbeat to prevent abuse)
        const duration = Math.min(Math.max(Number(activeDuration) || 0, 0), 3600);

        await UserSession.findOneAndUpdate(
            { sessionId },
            {
                $set: { lastActiveAt: new Date() },
                $inc: { totalDuration: duration },
            }
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('sessionHeartbeat error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /api/v2/analytics/session/end
 * End a session.
 */
export const endSession = async (req, res) => {
    try {
        const { sessionId, totalDuration } = req.body;
        if (!sessionId) {
            return res.status(400).json({ success: false, message: 'sessionId required' });
        }

        const duration = Math.min(Math.max(Number(totalDuration) || 0, 0), 86400); // max 24h

        await UserSession.findOneAndUpdate(
            { sessionId },
            {
                $set: {
                    endedAt: new Date(),
                    lastActiveAt: new Date(),
                    totalDuration: duration,
                },
            }
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('endSession error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── PAGE USAGE TRACKING ─────────────────────────────────────────────────────

/**
 * POST /api/v2/analytics/page-usage
 * Track time spent on a page.
 */
export const trackPageUsage = async (req, res) => {
    try {
        const { sessionId, pageName, timeSpent, enteredAt } = req.body;
        if (!sessionId || !pageName || timeSpent == null) {
            return res.status(400).json({ success: false, message: 'sessionId, pageName, timeSpent required' });
        }

        // Validate timeSpent (max 1 hour per page visit to prevent abuse)
        const validTime = Math.min(Math.max(Number(timeSpent) || 0, 0), 3600);
        if (validTime < 1) {
            return res.status(200).json({ success: true }); // Ignore <1s visits
        }

        const { dateBucket, monthBucket } = getBuckets(enteredAt ? new Date(enteredAt) : new Date());
        const device = getDevice(req.headers['user-agent']);

        await PageUsage.create({
            userId: req.user?.id || null,
            sessionId,
            pageName,
            timeSpent: validTime,
            enteredAt: enteredAt ? new Date(enteredAt) : new Date(),
            exitedAt: new Date(),
            dateBucket,
            monthBucket,
            device,
        });

        // Also update session's pagesVisited
        await UserSession.findOneAndUpdate(
            { sessionId },
            {
                $push: {
                    pagesVisited: {
                        $each: [{ pageName, timeSpent: validTime, visitedAt: new Date() }],
                        $slice: -50, // Keep last 50 page visits per session
                    },
                },
                $set: { lastActiveAt: new Date() },
            }
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('trackPageUsage error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── CONTENT WATCHTIME TRACKING ──────────────────────────────────────────────

/**
 * POST /api/v2/analytics/content-watchtime
 * Track actual play time for a content item (video, short, audio, post).
 */
export const trackContentWatchtime = async (req, res) => {
    try {
        const { sessionId, contentId, contentType } = req.body;

        if (!sessionId || !contentId || !contentType || !req.body.eventId) {
            return res.status(400).json({
                success: false,
                message: 'sessionId, contentId, contentType, eventId required',
            });
        }
        const { dateBucket, monthBucket } = getBuckets();
        const device = getDevice(req.headers['user-agent']);

        const content = await Content.findById(contentId).lean();
        const result = await recordWatchSignal({
            req,
            content,
            contentId,
            event: {
                ...req.body,
                sessionId,
            },
            device,
            dateBucket,
            monthBucket,
        });

        if (!result.success) {
            return res.status(404).json({ success: false, message: 'Content not found' });
        }

        return res.status(200).json({ success: true, viewCounted: result.viewCounted, duplicate: result.duplicate });
    } catch (error) {
        console.error('trackContentWatchtime error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── BATCH TRACKING ──────────────────────────────────────────────────────────

/**
 * POST /api/v2/analytics/batch
 * Batch submit multiple tracking events (page usage + content watchtime).
 * Reduces network requests from the frontend.
 */
export const batchTrack = async (req, res) => {
    try {
        const { sessionId, events } = req.body;
        if (!sessionId || !Array.isArray(events) || events.length === 0) {
            return res.status(400).json({ success: false, message: 'sessionId and events[] required' });
        }

        // Limit batch size to prevent abuse
        const safeEvents = events.slice(0, 50);
        const device = getDevice(req.headers['user-agent']);
        const userId = req.user?.id || null;

        const pageOps = [];
        const contentResults = [];

        for (const evt of safeEvents) {
            const { dateBucket, monthBucket } = getBuckets(evt.timestamp ? new Date(evt.timestamp) : new Date());

            if (evt.type === 'page_usage') {
                const timeSpent = Math.min(Math.max(Number(evt.timeSpent) || 0, 0), 3600);
                if (timeSpent >= 1) {
                    pageOps.push({
                        userId,
                        sessionId,
                        pageName: evt.pageName,
                        timeSpent,
                        enteredAt: evt.enteredAt ? new Date(evt.enteredAt) : new Date(),
                        exitedAt: new Date(),
                        dateBucket,
                        monthBucket,
                        device,
                    });
                }
            } else if (evt.type === 'content_watchtime') {
                const content = await Content.findById(evt.contentId).lean();
                if (content) {
                    contentResults.push(recordWatchSignal({
                        req: { ...req, user: req.user },
                        content,
                        contentId: evt.contentId,
                        event: {
                            ...evt,
                            sessionId,
                        },
                        device,
                        dateBucket,
                        monthBucket,
                    }));
                }
            }
        }

        const ops = [];
        if (pageOps.length > 0) ops.push(PageUsage.insertMany(pageOps, { ordered: false }));
        if (contentResults.length > 0) ops.push(Promise.all(contentResults));
        if (ops.length > 0) await Promise.all(ops);

        return res.status(200).json({ success: true, tracked: pageOps.length + contentResults.length });
    } catch (error) {
        console.error('batchTrack error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
