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
    // ── Content-type specific fields ──
    const typeSpecific = {};
    const contentTypeInc = {};
    const contentType = contentRecord.contentType;
    if (contentType === 'short') {
        typeSpecific.loopCount = Math.max(Number(event.loopCount) || 0, 0);
        typeSpecific.swipedAway = !!event.swipedAway;
        typeSpecific.swipeAwayAt = event.swipedAway ? (Number(event.swipeAwayAt) || playheadSeconds) : null;
        if (typeSpecific.loopCount > 0) contentTypeInc.loopCount = typeSpecific.loopCount;
        if (typeSpecific.swipedAway) contentTypeInc.swipeAwayCount = 1;
    } else if (contentType === 'audio') {
        typeSpecific.skipped = !!event.skipped;
        typeSpecific.replayCount = Math.max(Number(event.replayCount) || 0, 0);
        if (typeSpecific.skipped) contentTypeInc.skipCount = 1;
        if (typeSpecific.replayCount > 0) contentTypeInc.replayCount = typeSpecific.replayCount;
    } else if (contentType === 'post') {
        typeSpecific.impression = !!event.impression || eventType === 'play';
        typeSpecific.clickedThrough = !!event.clickedThrough;
        if (typeSpecific.impression) contentTypeInc.impressions = 1;
        if (typeSpecific.clickedThrough) contentTypeInc.clickThroughCount = 1;
    }

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
            ...typeSpecific,
        });
    } catch (error) {
        if (error?.code === 11000) {
            return { success: true, duplicate: true, viewCounted: false };
        }
        throw error;
    }

    const now = new Date();
    const bestPlayhead = Math.max(Number(contentRecord.furthestPlayheadSeconds) || 0, playheadSeconds || 0);
    const thisSessionCompletion = resolveCompletionRate(contentDuration, playheadSeconds);

    // Update content-level watch stats atomically
    const contentUpdate = {
        $inc: { totalWatchTime: activePlayTime },
        $max: { furthestPlayheadSeconds: bestPlayhead },
        $set: { lastWatchEventAt: now },
    };

    // Running average completion: only increment sum/count when a session ends
    // (ended, unload, pagehide) to avoid inflating the count on every heartbeat
    const isSessionEnd = eventType === 'ended' || eventType === 'unload' || eventType === 'pagehide';
    if (isSessionEnd && thisSessionCompletion !== null && thisSessionCompletion > 0) {
        contentUpdate.$inc.completionSumPercent = thisSessionCompletion;
        contentUpdate.$inc.completionSessionCount = 1;
    }

    // Merge content-type specific aggregate increments
    if (Object.keys(contentTypeInc).length > 0) {
        Object.assign(contentUpdate.$inc, contentTypeInc);
    }

    await Content.updateOne({ _id: contentRecord._id }, contentUpdate);

    const threshold = getWatchThreshold(contentRecord.contentType, contentDuration);
    const shouldCountView = activePlayTime >= threshold || completed || eventType === 'ended';

    let viewCounted = false;
    if (shouldCountView) {
        const viewerQuery = watcherIsAuthenticated
            ? { contentId: contentRecord._id, userId }
            : { contentId: contentRecord._id, anonymousViewerId };

        // ── Atomic view counting (race-condition safe) ──
        // Use findOneAndUpdate with the session check IN the filter, so two concurrent
        // requests for the same watchSessionId cannot both see "no match" and both increment.
        const sessionFilter = {
            ...viewerQuery,
            lastCountedWatchSessionId: { $ne: watchSessionId },
        };

        const viewerUpdate = {
            $set: {
                viewerType: watcherIsAuthenticated ? 'authenticated' : 'anonymous',
                sessionId: event.sessionId || watchSessionId || eventId,
                watchSessionId,
                lastPlayheadSeconds: playheadSeconds,
                lastWatchEventAt: now,
                lastCountedWatchSessionId: watchSessionId,
                ...(watcherIsAuthenticated ? { userId } : { anonymousViewerId, visitorFingerprint: anonymousViewerId }),
            },
            $max: { bestPlayheadSeconds: playheadSeconds || 0 },
            $inc: { viewCount: 1 },
            $setOnInsert: {
                firstViewedAt: now,
                weekBucket: dateBucket?.slice(0, 7) || undefined,
                monthBucket,
                ipAddress: watcherIsAuthenticated ? undefined : (req.ip || req.headers['x-forwarded-for'] || ''),
            },
        };

        // Try to match existing viewer with a different session → new session for existing viewer
        const sessionResult = await ContentView.findOneAndUpdate(sessionFilter, viewerUpdate, { upsert: false, new: true });

        if (sessionResult) {
            // Existing viewer, new session → increment views only
            const contentInc = watcherIsAuthenticated
                ? { views: 1, authenticatedViews: 1 }
                : { views: 1, anonymousViews: 1 };
            await Content.updateOne({ _id: contentRecord._id }, { $inc: contentInc });
            viewCounted = true;
        } else {
            // Either new viewer entirely, or same session already counted.
            // Try upsert without the session filter to create if truly new.
            const existingViewer = await ContentView.findOne(viewerQuery).lean();

            if (!existingViewer) {
                // Brand new viewer
                const newViewerUpdate = {
                    $set: {
                        viewerType: watcherIsAuthenticated ? 'authenticated' : 'anonymous',
                        sessionId: event.sessionId || watchSessionId || eventId,
                        watchSessionId,
                        lastPlayheadSeconds: playheadSeconds,
                        bestPlayheadSeconds: playheadSeconds || 0,
                        lastWatchEventAt: now,
                        lastCountedWatchSessionId: watchSessionId,
                        ...(watcherIsAuthenticated ? { userId } : { anonymousViewerId, visitorFingerprint: anonymousViewerId }),
                    },
                    $inc: { viewCount: 1 },
                    $setOnInsert: {
                        firstViewedAt: now,
                        weekBucket: dateBucket?.slice(0, 7) || undefined,
                        monthBucket,
                        ipAddress: watcherIsAuthenticated ? undefined : (req.ip || req.headers['x-forwarded-for'] || ''),
                    },
                };
                await ContentView.updateOne(viewerQuery, newViewerUpdate, { upsert: true });

                const contentInc = watcherIsAuthenticated
                    ? { views: 1, authenticatedViews: 1, authenticatedUniqueViewers: 1 }
                    : { views: 1, anonymousViews: 1, anonymousUniqueViewers: 1 };
                await Content.updateOne({ _id: contentRecord._id }, { $inc: contentInc });
                viewCounted = true;
            }
            // else: same session already counted → no-op (deduplication working correctly)
        }
    } else {
        // Below threshold — just update playhead position for resume, no view count
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
                    lastWatchEventAt: now,
                    ...(watcherIsAuthenticated ? { userId } : { anonymousViewerId, visitorFingerprint: anonymousViewerId }),
                },
                $max: { bestPlayheadSeconds: playheadSeconds || 0 },
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

    // ── Upsert WatchHistory for authenticated users ──
    if (watcherIsAuthenticated) {
        try {
            const user = await (await import('../models/user.model.js')).default.findById(userId, 'historyPaused');
            if (!user?.historyPaused) {
                const WatchHistory = (await import('../models/watchHistory.model.js')).default;
                const isCompleted = (consumptionPercent >= 80) || completed;
                
                const historyUpdate = {
                    $set: {
                        userId,
                        contentId: contentRecord._id,
                        contentType: contentRecord.contentType,
                        lastWatchedAt: now,
                        contentMetadata: {
                            title: contentRecord.title,
                            tags: contentRecord.tags || [],
                            category: contentRecord.category || '',
                            creatorId: contentRecord.userId,
                            duration: contentDuration
                        }
                    },
                    $max: {
                        watchTime: playheadSeconds,
                        watchPercentage: consumptionPercent || 0
                    },
                    $inc: { watchCount: isSessionEnd ? 1 : 0 }
                };

                if (isCompleted) {
                    historyUpdate.$set.completedWatch = true;
                }

                if (activePlayTime > 0) {
                    const sessionData = {
                        startedAt: new Date(now.getTime() - activePlayTime * 1000),
                        endedAt: now,
                        watchTime: activePlayTime,
                        device: device,
                        completedWatch: isCompleted
                    };
                    historyUpdate.$push = {
                        sessions: {
                            $each: [sessionData],
                            $slice: -20
                        }
                    };
                }

                await WatchHistory.findOneAndUpdate(
                    { userId, contentId: contentRecord._id },
                    historyUpdate,
                    { upsert: true }
                );

                // Enforce 100 item cap per user
                const historyCount = await WatchHistory.countDocuments({ userId });
                if (historyCount > 100) {
                    const oldestItems = await WatchHistory.find({ userId })
                        .sort({ lastWatchedAt: -1 })
                        .skip(100)
                        .select('_id');
                    
                    if (oldestItems.length > 0) {
                        const idsToDelete = oldestItems.map(item => item._id);
                        await WatchHistory.deleteMany({ _id: { $in: idsToDelete } });
                    }
                }
            }
        } catch (err) {
            console.error('Error updating WatchHistory:', err);
        }
    }

    // Recompute running average completion for the response
    const updatedContent = await Content.findById(contentRecord._id)
        .select('views totalWatchTime furthestPlayheadSeconds completionRate completionSumPercent completionSessionCount averageWatchPercent authenticatedViews anonymousViews authenticatedUniqueViewers anonymousUniqueViewers')
        .lean();

    // Derive completionRate as running average
    const avgCompletion = (updatedContent?.completionSessionCount > 0)
        ? Math.min(100, Math.round(updatedContent.completionSumPercent / updatedContent.completionSessionCount))
        : null;
    if (avgCompletion !== null && avgCompletion !== updatedContent?.completionRate) {
        await Content.updateOne({ _id: contentRecord._id }, { $set: { completionRate: avgCompletion, averageWatchPercent: avgCompletion } });
    }

    return {
        success: true,
        duplicate: false,
        viewCounted,
        content: { ...updatedContent, completionRate: avgCompletion ?? updatedContent?.completionRate },
        event: createdEvent,
    };
}
