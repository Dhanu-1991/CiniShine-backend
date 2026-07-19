import crypto from 'crypto';
import Content from '../models/content.model.js';
import ContentView from '../models/contentView.model.js';
import ContentWatchtime from '../models/contentWatchtime.model.js';

const getWatchThreshold = (contentType, durationSeconds = 0) => {
    if (contentType === 'post') return 1;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 5;
    return Math.max(1, Math.min(30, durationSeconds * 0.3));
};

const resolveAnonymousViewerId = (req, event) => {
    const supplied = event.anonymousViewerId || event.viewerId || event.sessionId || event.watchSessionId;
    if (supplied) return String(supplied);

    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const ua = req.get('User-Agent') || '';
    const lang = req.get('Accept-Language') || '';
    return crypto.createHash('sha256').update(`${ip}|${ua}|${lang}`).digest('hex');
};

const resolvePlayheadSeconds = (event) => {
    const playhead = Number(event.playheadSeconds);
    if (Number.isFinite(playhead) && playhead >= 0) return playhead;

    const fallback = Number(event.activePlayTime) / 1000;
    return Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
};

const resolveCompletionRate = (durationSeconds, playheadSeconds) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return playheadSeconds > 0 ? null : 0;
    }

    if (!Number.isFinite(playheadSeconds) || playheadSeconds <= 0) {
        return 0;
    }

    return Math.min(100, Math.round((playheadSeconds / durationSeconds) * 100));
};

export async function recordWatchSignal({ req, content, contentId, event, device, dateBucket, monthBucket }) {
    if (!content && !contentId) {
        throw new Error('content is required');
    }

    const contentRecord = content || await Content.findById(contentId);
    if (!contentRecord) {
        return { success: false, reason: 'content-not-found' };
    }

    const watcherIsAuthenticated = !!req.user?.id;
    const userId = watcherIsAuthenticated ? req.user.id : null;
    const anonymousViewerId = watcherIsAuthenticated ? null : resolveAnonymousViewerId(req, event);
    const watchSessionId = event.watchSessionId || event.sessionId || null;
    const eventId = String(event.eventId || `${contentRecord._id}-${watchSessionId || 'watch'}-${Date.now()}`);
    const eventType = event.eventType || 'heartbeat';
    const activePlayTime = Math.min(Math.max(Number(event.activePlayTime) || 0, 0), 14400);
    const playheadSeconds = resolvePlayheadSeconds(event);
    const contentDuration = Number.isFinite(Number(event.contentDuration)) && Number(event.contentDuration) > 0
        ? Number(event.contentDuration)
        : Number(contentRecord.duration) || 0;
    const completed = !!event.completed || eventType === 'ended' || (contentDuration > 0 && playheadSeconds >= contentDuration);

    const existingEvent = await ContentWatchtime.findOne({ eventId }).lean();
    if (existingEvent) {
        return { success: true, duplicate: true, viewCounted: false };
    }

    if (!contentRecord.duration && contentDuration > 0) {
        contentRecord.duration = contentDuration;
        await contentRecord.save();
    }

    const consumptionPercent = resolveCompletionRate(contentDuration, playheadSeconds);
    let createdEvent;
    try {
        createdEvent = await ContentWatchtime.create({
            eventId,
            userId,
            anonymousViewerId,
            isAuthenticated: watcherIsAuthenticated,
            sessionId: event.sessionId || watchSessionId || eventId,
            watchSessionId,
            eventType,
            contentId: contentRecord._id,
            contentType: contentRecord.contentType,
            activePlayTime,
            playheadSeconds,
            contentDuration,
            consumptionPercent,
            completed,
            totalBufferTime: Math.max(Number(event.bufferTime) || 0, 0),
            totalPauseTime: Math.max(Number(event.pauseTime) || 0, 0),
            totalSeekTime: Math.max(Number(event.seekTime) || 0, 0),
            readTime: Math.max(Number(event.readTime) || 0, 0),
            creatorId: event.creatorId || contentRecord.userId || null,
            dateBucket,
            monthBucket,
            device,
        });
    } catch (error) {
        if (error?.code === 11000) {
            return { success: true, duplicate: true, viewCounted: false };
        }
        throw error;
    }

    const now = new Date();
    const bestPlayhead = Math.max(Number(contentRecord.furthestPlayheadSeconds) || 0, playheadSeconds || 0);
    const completionRate = resolveCompletionRate(Number(contentRecord.duration) || contentDuration, bestPlayhead);

    await Content.updateOne(
        { _id: contentRecord._id },
        {
            $inc: { totalWatchTime: activePlayTime },
            $max: { furthestPlayheadSeconds: bestPlayhead },
            $set: {
                lastWatchEventAt: now,
                completionRate,
                averageWatchPercent: completionRate,
            },
        }
    );

    const threshold = getWatchThreshold(contentRecord.contentType, contentDuration);
    const shouldCountView = activePlayTime >= threshold || completed || eventType === 'ended';

    let viewCounted = false;
    if (shouldCountView) {
        const viewerQuery = watcherIsAuthenticated
            ? { contentId: contentRecord._id, userId }
            : { contentId: contentRecord._id, anonymousViewerId };

        const existingViewer = await ContentView.findOne(viewerQuery).lean();
        const isNewViewer = !existingViewer;
        const isNewSession = existingViewer?.lastCountedWatchSessionId !== watchSessionId;

        const viewerUpdate = {
            $set: {
                viewerType: watcherIsAuthenticated ? 'authenticated' : 'anonymous',
                sessionId: event.sessionId || watchSessionId || eventId,
                watchSessionId,
                lastPlayheadSeconds: playheadSeconds,
                bestPlayheadSeconds: Math.max(Number(existingViewer?.bestPlayheadSeconds) || 0, playheadSeconds || 0),
                lastWatchEventAt: now,
            },
            $setOnInsert: {
                firstViewedAt: now,
                weekBucket: dateBucket?.slice(0, 7) || undefined,
                monthBucket,
                ipAddress: watcherIsAuthenticated ? undefined : (req.ip || req.headers['x-forwarded-for'] || ''),
            },
        };

        if (watcherIsAuthenticated) {
            viewerUpdate.$set.userId = userId;
        } else {
            viewerUpdate.$set.anonymousViewerId = anonymousViewerId;
            viewerUpdate.$set.visitorFingerprint = anonymousViewerId;
        }

        if (isNewSession) {
            viewerUpdate.$set.lastCountedWatchSessionId = watchSessionId;
            viewerUpdate.$inc = { viewCount: 1 };
        }

        if (isNewViewer) {
            viewerUpdate.$setOnInsert.viewerType = watcherIsAuthenticated ? 'authenticated' : 'anonymous';
        }

        await ContentView.updateOne(viewerQuery, viewerUpdate, { upsert: true });

        if (isNewSession) {
            const contentInc = watcherIsAuthenticated
                ? { views: 1, authenticatedViews: 1, ...(isNewViewer ? { authenticatedUniqueViewers: 1 } : {}) }
                : { views: 1, anonymousViews: 1, ...(isNewViewer ? { anonymousUniqueViewers: 1 } : {}) };

            await Content.updateOne({ _id: contentRecord._id }, { $inc: contentInc });
            viewCounted = true;
        }
    } else {
        await ContentView.updateOne(
            watcherIsAuthenticated
                ? { contentId: contentRecord._id, userId }
                : { contentId: contentRecord._id, anonymousViewerId },
            {
                $set: {
                    viewerType: watcherIsAuthenticated ? 'authenticated' : 'anonymous',
                    sessionId: event.sessionId || watchSessionId || eventId,
                    watchSessionId,
                    lastPlayheadSeconds: playheadSeconds,
                    bestPlayheadSeconds: bestPlayhead,
                    lastWatchEventAt: now,
                    ...(watcherIsAuthenticated ? { userId } : { anonymousViewerId, visitorFingerprint: anonymousViewerId }),
                },
                $setOnInsert: {
                    firstViewedAt: now,
                    weekBucket: dateBucket?.slice(0, 7) || undefined,
                    monthBucket,
                    ipAddress: watcherIsAuthenticated ? undefined : (req.ip || req.headers['x-forwarded-for'] || ''),
                },
            },
            { upsert: true }
        );
    }

    const updatedContent = await Content.findById(contentRecord._id).select('views totalWatchTime furthestPlayheadSeconds completionRate averageWatchPercent authenticatedViews anonymousViews authenticatedUniqueViewers anonymousUniqueViewers').lean();

    return {
        success: true,
        duplicate: false,
        viewCounted,
        content: updatedContent,
        event: createdEvent,
    };
}
