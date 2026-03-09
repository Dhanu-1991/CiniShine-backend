import PageUsage from '../../models/pageUsage.model.js';
import ContentWatchtime from '../../models/contentWatchtime.model.js';
import UserSession from '../../models/userSession.model.js';

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
        const {
            sessionId, contentId, contentType,
            activePlayTime, contentDuration, completed,
            bufferTime, pauseTime, seekTime, readTime,
            creatorId,
        } = req.body;

        if (!sessionId || !contentId || !contentType || activePlayTime == null) {
            return res.status(400).json({
                success: false,
                message: 'sessionId, contentId, contentType, activePlayTime required',
            });
        }

        // Validate activePlayTime (max 4 hours per tracking event)
        const validPlayTime = Math.min(Math.max(Number(activePlayTime) || 0, 0), 14400);
        if (validPlayTime < 1) {
            return res.status(200).json({ success: true }); // Ignore <1s
        }

        const dur = Number(contentDuration) || 0;
        const consumptionPercent = dur > 0
            ? Math.min(Math.round((validPlayTime / dur) * 100), 100)
            : 0;

        const { dateBucket, monthBucket } = getBuckets();
        const device = getDevice(req.headers['user-agent']);

        await ContentWatchtime.create({
            userId: req.user?.id || null,
            sessionId,
            contentId,
            contentType,
            activePlayTime: validPlayTime,
            contentDuration: dur,
            consumptionPercent,
            completed: !!completed,
            totalBufferTime: Math.max(Number(bufferTime) || 0, 0),
            totalPauseTime: Math.max(Number(pauseTime) || 0, 0),
            totalSeekTime: Math.max(Number(seekTime) || 0, 0),
            readTime: Math.max(Number(readTime) || 0, 0),
            creatorId: creatorId || null,
            dateBucket,
            monthBucket,
            device,
        });

        return res.status(200).json({ success: true });
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
        const contentOps = [];

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
                const activePlayTime = Math.min(Math.max(Number(evt.activePlayTime) || 0, 0), 14400);
                if (activePlayTime >= 1) {
                    const dur = Number(evt.contentDuration) || 0;
                    contentOps.push({
                        userId,
                        sessionId,
                        contentId: evt.contentId,
                        contentType: evt.contentType,
                        activePlayTime,
                        contentDuration: dur,
                        consumptionPercent: dur > 0 ? Math.min(Math.round((activePlayTime / dur) * 100), 100) : 0,
                        completed: !!evt.completed,
                        totalBufferTime: Math.max(Number(evt.bufferTime) || 0, 0),
                        totalPauseTime: Math.max(Number(evt.pauseTime) || 0, 0),
                        totalSeekTime: Math.max(Number(evt.seekTime) || 0, 0),
                        readTime: Math.max(Number(evt.readTime) || 0, 0),
                        creatorId: evt.creatorId || null,
                        dateBucket,
                        monthBucket,
                        device,
                    });
                }
            }
        }

        const ops = [];
        if (pageOps.length > 0) ops.push(PageUsage.insertMany(pageOps, { ordered: false }));
        if (contentOps.length > 0) ops.push(ContentWatchtime.insertMany(contentOps, { ordered: false }));
        if (ops.length > 0) await Promise.all(ops);

        return res.status(200).json({ success: true, tracked: pageOps.length + contentOps.length });
    } catch (error) {
        console.error('batchTrack error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
