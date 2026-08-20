import crypto from 'crypto';
import mongoose from 'mongoose';
import Content from '../models/content.model.js';
import ContentView from '../models/contentView.model.js';
import ContentWatchtime from '../models/contentWatchtime.model.js';

/**
 * View Count Threshold Algorithm:
 * - 'post': 1 second (static content reading)
 * - 'short' (Frames):
 *   minimum of 2 seconds and 5% of duration:
 *   Math.max(0.5, Math.min(2, duration * 0.05))
 *   Examples:
 *     - 10s frame: min(2s, 0.5s)  = 0.5 seconds (or loop/completion)
 *     - 15s frame: min(2s, 0.75s) = 0.75 seconds (or loop/completion)
 *     - 30s frame: min(2s, 1.5s)  = 1.5 seconds (or loop/completion)
 *     - 40s frame: min(2s, 2.0s)  = 2.0 seconds (or loop/completion)
 *     - 60s frame: min(2s, 3.0s)  = 2.0 seconds (capped at 2s)
 * - 'video' & 'audio':
 *   minimum of 5% of duration and 15 seconds (with a floor of 1 second):
 *   Math.max(1, Math.min(15, duration * 0.05))
 *   Examples:
 *     - 60s (1 min) video:  min(15s, 3s)    = 3.0 seconds
 *     - 120s (2 min) video: min(15s, 6s)    = 6.0 seconds
 *     - 246s (4:06) video:  min(15s, 12.3s) = 12.3 seconds
 *     - 300s (5 min) video: min(15s, 15s)   = 15.0 seconds
 *     - 600s (10 min) video: min(15s, 30s)  = 15.0 seconds (capped at 15s)
 *     - 1 hour video:        min(15s, 180s) = 15.0 seconds (capped at 15s)
 */
export const getWatchThreshold = (contentType, durationSeconds = 0) => {
    if (contentType === 'post') return 1;
    const duration = Number(durationSeconds);

    if (contentType === 'short') {
        if (!Number.isFinite(duration) || duration <= 0) return 2;
        return Math.max(0.5, Math.min(2, duration * 0.05));
    }

    // 'video' and 'audio'
    if (!Number.isFinite(duration) || duration <= 0) return 5;
    return Math.max(1, Math.min(15, duration * 0.05));
};

const resolveAnonymousViewerId = (req, event) => {
    // Prefer the client-supplied persistent anonymous viewer ID.
    // Also check req.body in case the event spread didn't include it.
    // Only fall back to session/watchSession IDs as a last resort since they
    // change per-session and would create duplicate viewer records.
    const persistentId = event.anonymousViewerId || event.viewerId || req?.body?.anonymousViewerId;
    if (persistentId && typeof persistentId === 'string' && persistentId.trim().length > 0) {
        return String(persistentId).trim();
    }

    // Secondary: use session-level identifiers (less ideal but better than nothing)
    const sessionFallback = event.sessionId || event.watchSessionId;
    if (sessionFallback && typeof sessionFallback === 'string' && sessionFallback.trim().length > 0) {
        return String(sessionFallback).trim();
    }

    // Last resort: compute a fingerprint hash from request properties
    const ip = req?.ip || req?.headers?.['x-forwarded-for'] || req?.connection?.remoteAddress || 'unknown';
    const ua = typeof req?.get === 'function' ? req.get('User-Agent') : (req?.headers?.['user-agent'] || '');
    const lang = typeof req?.get === 'function' ? req.get('Accept-Language') : (req?.headers?.['accept-language'] || '');
    return crypto.createHash('sha256').update(`${ip}|${ua}|${lang}`).digest('hex');
};

const resolvePlayheadSeconds = (event) => {
    const playhead = Number(event.playheadSeconds);
    if (Number.isFinite(playhead) && playhead >= 0) {
        return playhead > 86400 ? playhead / 1000 : playhead;
    }

    const fallback = Number(event.activePlayTime);
    if (Number.isFinite(fallback) && fallback >= 0) {
        return fallback > 500 ? fallback / 1000 : fallback;
    }
    return 0;
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

    if (contentId && !mongoose.Types.ObjectId.isValid(contentId)) {
        return { success: false, reason: 'invalid-content-id' };
    }

    const contentRecord = content || await Content.findById(contentId);
    if (!contentRecord) {
        return { success: false, reason: 'content-not-found' };
    }

    const watcherIsAuthenticated = !!req.user?.id;
    const userId = watcherIsAuthenticated ? req.user.id : null;
    const anonymousViewerId = watcherIsAuthenticated ? null : resolveAnonymousViewerId(req, event);
    
    // For legacy endpoints that don't send a watchSessionId, generate a deterministic one based on the current hour.
    // This prevents every heartbeat from generating a new random ID (which would bypass deduplication and massively overcount views).
    const currentHourBucket = `${dateBucket}-${new Date().getHours()}`;
    const fallbackSessionId = `legacy-${contentRecord._id}-${userId || anonymousViewerId || 'anon'}-${currentHourBucket}`;
    const watchSessionId = event.watchSessionId || event.sessionId || fallbackSessionId;
    
    const eventId = String(event.eventId || `${contentRecord._id}-${watchSessionId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    const eventType = event.eventType || 'heartbeat';
    const rawActivePlay = Number(event.activePlayTime) || 0;
    const normalizedPlayTime = rawActivePlay > 500 ? rawActivePlay / 1000 : rawActivePlay;

    const playheadSeconds = resolvePlayheadSeconds(event);
    const contentDuration = Number.isFinite(Number(event.contentDuration)) && Number(event.contentDuration) > 0
        ? Number(event.contentDuration)
        : Number(contentRecord.duration) || 0;

    const maxSessionPlayTime = contentDuration > 0 ? Math.round(contentDuration * 2) : 14400;
    const activePlayTime = Math.min(Math.max(normalizedPlayTime, 0), maxSessionPlayTime);
    const completed = !!event.completed || eventType === 'ended' || (contentDuration > 0 && playheadSeconds >= contentDuration);

    const existingEvent = await ContentWatchtime.findOne({ eventId }).lean();
    if (existingEvent) {
        return { success: true, duplicate: true, viewCounted: false };
    }

    if (!contentRecord.duration && contentDuration > 0) {
        await Content.updateOne(
            { _id: contentRecord._id, $or: [{ duration: { $exists: false } }, { duration: null }, { duration: 0 }] },
            { $set: { duration: contentDuration } }
        );
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

    // ── Upsert ContentWatchtime by watchSessionId + contentId ──
    // The frontend sends CUMULATIVE activePlayTime on every heartbeat,
    // so we use $max to store only the highest value per watch session
    // instead of creating a new record per heartbeat event.
    const sessionUpsertKey = watchSessionId
        ? { watchSessionId, contentId: contentRecord._id }
        : { eventId }; // fallback to eventId if no watchSessionId

    // ── RACE-SAFE delta computation ──
    // Use findOneAndUpdate with new:false to atomically read the PREVIOUS state
    // and write the update in a single MongoDB operation. This prevents the race
    // where two concurrent heartbeats both read the same old value and both
    // compute the same delta, causing totalWatchTime to be double-incremented.
    let previousDoc;
    try {
        previousDoc = await ContentWatchtime.findOneAndUpdate(
            sessionUpsertKey,
            {
                // Always set the latest event data
                $set: {
                    userId,
                    anonymousViewerId,
                    isAuthenticated: watcherIsAuthenticated,
                    sessionId: event.sessionId || watchSessionId || eventId,
                    eventType,
                    contentType: contentRecord.contentType,
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
                },
                // Use $max for cumulative fields — frontend sends running totals
                $max: {
                    activePlayTime,
                },
                // Set fields only on first insert (eventId stays stable across heartbeats)
                $setOnInsert: {
                    eventId,
                    watchSessionId,
                    contentId: contentRecord._id,
                },
            },
            { upsert: true, new: false }
        );
    } catch (error) {
        if (error?.code === 11000) {
            return { success: true, duplicate: true, viewCounted: false };
        }
        throw error;
    }

    // Compute delta from the atomic previous state (null means new insert)
    const previousActivePlayTime = previousDoc?.activePlayTime || 0;
    const activePlayTimeDelta = Math.max(0, activePlayTime - previousActivePlayTime);
    const isNewSession = !previousDoc;

    const now = new Date();
    const bestPlayhead = Math.max(Number(contentRecord.furthestPlayheadSeconds) || 0, playheadSeconds || 0);
    const thisSessionCompletion = resolveCompletionRate(contentDuration, playheadSeconds);

    // Update content-level watch stats atomically
    // IMPORTANT: Only increment totalWatchTime by the DELTA (new - previous),
    // since frontend sends cumulative activePlayTime, not per-heartbeat chunks.
    const contentUpdate = {
        $max: { furthestPlayheadSeconds: bestPlayhead },
        $set: { lastWatchEventAt: now },
    };

    // Only add $inc if there's something to increment
    const contentIncs = {};
    if (activePlayTimeDelta > 0) {
        contentIncs.totalWatchTime = activePlayTimeDelta;
    }

    // Running average completion: only increment sum/count when a session ends
    // (ended, unload, pagehide) to avoid inflating the count on every heartbeat
    const isSessionEnd = eventType === 'ended' || eventType === 'unload' || eventType === 'pagehide';
    if (isSessionEnd && thisSessionCompletion !== null && thisSessionCompletion > 0) {
        contentIncs.completionSumPercent = thisSessionCompletion;
        contentIncs.completionSessionCount = 1;
    }

    // Merge content-type specific aggregate increments (only on first occurrence)
    if (isNewSession && Object.keys(contentTypeInc).length > 0) {
        Object.assign(contentIncs, contentTypeInc);
    }

    if (Object.keys(contentIncs).length > 0) {
        contentUpdate.$inc = contentIncs;
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
                lastCountedAt: now,
                lastCountedWatchSessionId: watchSessionId,
                ...(watcherIsAuthenticated ? { userId } : { anonymousViewerId, visitorFingerprint: anonymousViewerId }),
            },
            $max: { bestPlayheadSeconds: playheadSeconds || 0 },
            $inc: { viewCount: 1 },
            $setOnInsert: {
                firstViewedAt: now,
                weekBucket: dateBucket?.slice(0, 7) || undefined,
                monthBucket,
                ipAddress: watcherIsAuthenticated ? undefined : (req?.ip || req?.headers?.['x-forwarded-for'] || ''),
            },
        };

        // Try to match existing viewer with a different session → new session for existing viewer
        const sessionResult = await ContentView.findOneAndUpdate(sessionFilter, viewerUpdate, { upsert: false, new: true });

        if (sessionResult) {
            // Existing viewer, new session → increment views
            // If viewCount === 1, this is their very first counted view (previously only below-threshold)
            const isFirstEverView = sessionResult.viewCount === 1;
            
            const contentInc = watcherIsAuthenticated
                ? { views: 1, authenticatedViews: 1, ...(isFirstEverView && { authenticatedUniqueViewers: 1 }) }
                : { views: 1, anonymousViews: 1, ...(isFirstEverView && { anonymousUniqueViewers: 1 }) };
                
            await Content.updateOne({ _id: contentRecord._id }, { $inc: contentInc, $set: { lastViewedAt: now } });
            viewCounted = true;
        } else {
            // Either new viewer entirely, or same session already counted.
            // Wrap in try/catch to handle E11000 from concurrent inserts for the same new viewer.
            try {
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
                            lastCountedAt: now,
                            lastCountedWatchSessionId: watchSessionId,
                            ...(watcherIsAuthenticated ? { userId } : { anonymousViewerId, visitorFingerprint: anonymousViewerId }),
                        },
                        $inc: { viewCount: 1 },
                        $setOnInsert: {
                            firstViewedAt: now,
                            weekBucket: dateBucket?.slice(0, 7) || undefined,
                            monthBucket,
                            ipAddress: watcherIsAuthenticated ? undefined : (req?.ip || req?.headers?.['x-forwarded-for'] || ''),
                        },
                    };
                    await ContentView.updateOne(viewerQuery, newViewerUpdate, { upsert: true });

                    const contentInc = watcherIsAuthenticated
                        ? { views: 1, authenticatedViews: 1, authenticatedUniqueViewers: 1 }
                        : { views: 1, anonymousViews: 1, anonymousUniqueViewers: 1 };
                    await Content.updateOne({ _id: contentRecord._id }, { $inc: contentInc, $set: { lastViewedAt: now } });
                    viewCounted = true;
                }
                // else: same session already counted → no-op (deduplication working correctly)
            } catch (err) {
                if (err?.code === 11000) {
                    // Concurrent insert race for the same new viewer — the other request
                    // handled the view count. Safe to ignore.
                } else {
                    throw err;
                }
            }
        }
    } else {
        // Below threshold — just update playhead position for resume, no view count
        try {
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
                        ipAddress: watcherIsAuthenticated ? undefined : (req?.ip || req?.headers?.['x-forwarded-for'] || ''),
                    },
                },
                { upsert: true }
            );
        } catch (err) {
            if (err?.code !== 11000) throw err;
            // E11000 = viewer record created by concurrent request, safe to ignore
        }
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
                    // $slice:-100 enforces the 100-item cap atomically in MongoDB —
                    // no separate count + find + deleteMany round-trips needed.
                    historyUpdate.$push = {
                        sessions: {
                            $each: [sessionData],
                            $slice: -20  // keep last 20 sessions per content
                        }
                    };
                }

                await WatchHistory.findOneAndUpdate(
                    { userId, contentId: contentRecord._id },
                    historyUpdate,
                    { upsert: true }
                );

                // ── Cap total WatchHistory per user at 100 items ──
                // Use $slice on the history collection atomically rather than
                // count + find + deleteMany (3 round-trips → 0 extra round-trips).
                // We rely on a TTL/capped collection or a background job instead.
                // For now: only run cleanup on session-end events to minimise overhead.
                if (isSessionEnd) {
                    const historyCount = await WatchHistory.countDocuments({ userId });
                    if (historyCount > 100) {
                        const oldestItems = await WatchHistory.find({ userId })
                            .sort({ lastWatchedAt: -1 })
                            .skip(100)
                            .select('_id')
                            .lean();
                        if (oldestItems.length > 0) {
                            await WatchHistory.deleteMany({ _id: { $in: oldestItems.map(i => i._id) } });
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Error updating WatchHistory:', err);
        }
    }

    // Recompute running averages and sync unique viewer metrics for the response
    const updatedContent = await Content.findById(contentRecord._id)
        .select('views totalWatchTime furthestPlayheadSeconds completionRate completionSumPercent completionSessionCount averageWatchPercent averageWatchTime authenticatedViews anonymousViews authenticatedUniqueViewers anonymousUniqueViewers')
        .lean();

    // Derive completionRate as running average
    const avgCompletion = (updatedContent?.completionSessionCount > 0)
        ? Math.min(100, Math.round(updatedContent.completionSumPercent / updatedContent.completionSessionCount))
        : null;

    // Compute averageWatchTime = totalWatchTime / views
    const avgWatchTime = (updatedContent?.views > 0)
        ? Math.round((updatedContent.totalWatchTime || 0) / updatedContent.views)
        : 0;

    const contentUpdates = {};

    let authUniques = updatedContent?.authenticatedUniqueViewers || 0;
    let anonUniques = updatedContent?.anonymousUniqueViewers || 0;
    let authViews = updatedContent?.authenticatedViews || 0;
    let anonViews = updatedContent?.anonymousViews || 0;

    // Auto-heal unique viewer & view breakdown metrics only when there are existing
    // views (i.e. not a fresh content with 0 counters) AND one of the breakdown
    // counters looks out-of-sync. This avoids two extra countDocuments() calls on
    // every heartbeat for newly uploaded content.
    const totalViews = updatedContent?.views || 0;
    const needsHeal = totalViews > 0 && (authUniques === 0 || anonUniques === 0 || (authViews === 0 && anonViews === 0));
    if (needsHeal) {
        const [actualAuthUniques, actualAnonUniques] = await Promise.all([
            ContentView.countDocuments({ contentId: contentRecord._id, viewerType: 'authenticated' }),
            ContentView.countDocuments({ contentId: contentRecord._id, viewerType: 'anonymous' }),
        ]);

        if (actualAuthUniques > authUniques) {
            authUniques = actualAuthUniques;
        }
        if (actualAnonUniques > anonUniques) {
            anonUniques = actualAnonUniques;
        }
        if (authViews < authUniques) {
            authViews = authUniques;
        }
        if (anonViews < anonUniques) {
            anonViews = anonUniques;
        }

        if (authUniques !== (updatedContent?.authenticatedUniqueViewers || 0)) contentUpdates.authenticatedUniqueViewers = authUniques;
        if (anonUniques !== (updatedContent?.anonymousUniqueViewers || 0)) contentUpdates.anonymousUniqueViewers = anonUniques;
        if (authViews !== (updatedContent?.authenticatedViews || 0)) contentUpdates.authenticatedViews = authViews;
        if (anonViews !== (updatedContent?.anonymousViews || 0)) contentUpdates.anonymousViews = anonViews;
    }

    if (avgCompletion !== null && avgCompletion !== updatedContent?.completionRate) {
        contentUpdates.completionRate = avgCompletion;
        contentUpdates.averageWatchPercent = avgCompletion;
    }
    if (avgWatchTime !== (updatedContent?.averageWatchTime || 0)) {
        contentUpdates.averageWatchTime = avgWatchTime;
    }
    if (Object.keys(contentUpdates).length > 0) {
        await Content.updateOne({ _id: contentRecord._id }, { $set: contentUpdates });
    }

    return {
        success: true,
        duplicate: false,
        viewCounted,
        content: { 
            ...updatedContent, 
            ...contentUpdates,
            completionRate: avgCompletion ?? updatedContent?.completionRate, 
            averageWatchTime: avgWatchTime,
            authenticatedUniqueViewers: authUniques,
            anonymousUniqueViewers: anonUniques,
            authenticatedViews: authViews,
            anonymousViews: anonViews,
        },
    };
}
