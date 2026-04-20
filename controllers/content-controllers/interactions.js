/**
 * interactions.js — VIDEO engagement & watch time tracking
 * 
 * ═══════════════════════════════════════════════════════════
 * HOW VIEWS ARE COUNTED (for VIDEOS only — shorts/audio/posts use sharedContentController.js):
 * ═══════════════════════════════════════════════════════════
 * 1. Frontend (WatchPage.jsx) accumulates watch time in ms via play/pause events.
 * 2. Watch time is sent to POST /api/v2/video/:id/watch-time with duration-based cadence and on page leave.
 * 3. Backend converts ms → seconds, then applies constraints:
 *    - MIN_WATCH_TIME: dynamic — 1s for videos <10s, 5s otherwise
 *    - MAX_WATCH_TIME: 1.5× video duration (or 1hr if no duration)
 * 4. Rate-limited by duration between updates per user+video (in-memory cache):
 *    - <10s: 3s
 *    - 10-60s: 5s
 *    - 60-600s (1-10m): 10s
 *    - >600s (>10m): 15s
 * 5. View counting thresholds (based on video duration):
 *    - <10s video  → 2s watch required
 *    - 10-60s video → 5s watch required
 *    - >60s video  → 15s watch required
 * 6. Hard de-duplication (max one counted view per user+video):
 *    - Existing user.viewHistory entry blocks recount
 *    - ContentView unique upsert is the race-safe final gate
 * 7. When a view IS counted: video.views++, then averageWatchTime = totalWatchTime / views
 * 8. totalWatchTime ALWAYS accumulates (even when view isn't counted)
 *
 * ═══════════════════════════════════════════════════════════
 * HOW AVERAGE WATCH TIME IS CALCULATED:
 * ═══════════════════════════════════════════════════════════
 * averageWatchTime = totalWatchTime / views
 * - totalWatchTime accumulates every valid watch session (above 5s, below 1.5x duration)
 * - averageWatchTime is only recalculated when a NEW VIEW is counted
 * - Used by recommendationAlgorithm.js: watchTimeScore = min(avgWatchTime / duration, 1)
 *   → measures retention rate (weight: 0.10 for videos)
 * ═══════════════════════════════════════════════════════════
 */
import Content from "../../models/content.model.js";
import User from "../../models/user.model.js";
import VideoReaction from "../../models/videoReaction.model.js";
import WatchHistory from "../../models/watchHistory.model.js";
import ContentView from "../../models/contentView.model.js";

// In-memory cache for rate limiting (resets on server restart)
const watchRateLimit = new Map();
const viewHistoryRateLimit = new Map();

/**
 * Duration bracket configuration — every permutation covered.
 * Each bracket defines: { maxDuration, viewThreshold, cooldownMs, minWatch, maxWatchFactor }
 * 
 * | Duration       | View Threshold | Cooldown | Min Watch | Max Watch       |
 * |----------------|---------------|----------|-----------|-----------------|
 * | 0–5s           | 1s            | 2000ms   | 1s        | 1.5× or 7.5s    |
 * | 5–10s          | 2s            | 3000ms   | 1s        | 1.5× or 15s     |
 * | 10–30s         | 5s            | 5000ms   | 5s        | 1.5× or 45s     |
 * | 30–60s         | 5s            | 5000ms   | 5s        | 1.5× or 90s     |
 * | 1–5min         | 10s           | 10000ms  | 5s        | 1.5× or 450s    |
 * | 5–10min        | 15s           | 10000ms  | 5s        | 1.5× or 900s    |
 * | 10–30min       | 30s           | 15000ms  | 5s        | 1.5× or 2700s   |
 * | 30–60min       | 30s           | 15000ms  | 5s        | 1.5× or 5400s   |
 * | 60min+         | 30s           | 15000ms  | 5s        | 1.5× dur        |
 * | Unknown (0)    | 5s            | 10000ms  | 5s        | 3600s           |
 */
const DURATION_BRACKETS = [
    { maxDuration: 5,    viewThreshold: 1,  cooldownMs: 2000,  minWatch: 1, maxWatchFallback: 7.5 },
    { maxDuration: 10,   viewThreshold: 2,  cooldownMs: 3000,  minWatch: 1, maxWatchFallback: 15 },
    { maxDuration: 30,   viewThreshold: 5,  cooldownMs: 5000,  minWatch: 5, maxWatchFallback: 45 },
    { maxDuration: 60,   viewThreshold: 5,  cooldownMs: 5000,  minWatch: 5, maxWatchFallback: 90 },
    { maxDuration: 300,  viewThreshold: 10, cooldownMs: 10000, minWatch: 5, maxWatchFallback: 450 },
    { maxDuration: 600,  viewThreshold: 15, cooldownMs: 10000, minWatch: 5, maxWatchFallback: 900 },
    { maxDuration: 1800, viewThreshold: 30, cooldownMs: 15000, minWatch: 5, maxWatchFallback: 2700 },
    { maxDuration: 3600, viewThreshold: 30, cooldownMs: 15000, minWatch: 5, maxWatchFallback: 5400 },
    { maxDuration: Infinity, viewThreshold: 30, cooldownMs: 15000, minWatch: 5, maxWatchFallback: null },
];

// Default bracket for unknown/zero duration
const UNKNOWN_DURATION_BRACKET = { viewThreshold: 5, cooldownMs: 10000, minWatch: 5, maxWatch: 3600 };

/**
 * Get the full bracket config for a given video duration.
 * @param {number} durationSeconds — video duration in seconds (0 = unknown)
 * @returns {{ viewThreshold: number, cooldownMs: number, minWatch: number, maxWatch: number }}
 */
const getBracket = (durationSeconds = 0) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return UNKNOWN_DURATION_BRACKET;
    }
    for (const b of DURATION_BRACKETS) {
        if (durationSeconds <= b.maxDuration) {
            return {
                viewThreshold: b.viewThreshold,
                cooldownMs: b.cooldownMs,
                minWatch: b.minWatch,
                maxWatch: b.maxWatchFallback !== null
                    ? Math.max(b.maxWatchFallback, durationSeconds * 1.5)
                    : durationSeconds * 1.5,
            };
        }
    }
    // Shouldn't reach here, but safe fallback
    return UNKNOWN_DURATION_BRACKET;
};

const getMinWatchUpdateGapMs = (durationSeconds = 0) => getBracket(durationSeconds).cooldownMs;

const getViewThresholdSeconds = (durationSeconds = 0) => getBracket(durationSeconds).viewThreshold;

const buildViewBuckets = (now = new Date()) => {
    const year = now.getFullYear();
    const week = Math.ceil(((now - new Date(year, 0, 1)) / 86400000 + 1) / 7);
    const month = String(now.getMonth() + 1).padStart(2, '0');

    return {
        weekBucket: `${year}-W${String(week).padStart(2, '0')}`,
        monthBucket: `${year}-${month}`,
    };
};

const ensureUniqueContentView = async ({ contentId, userId, now = new Date() }) => {
    const { weekBucket, monthBucket } = buildViewBuckets(now);

    try {
        const result = await ContentView.updateOne(
            { contentId, userId },
            {
                $setOnInsert: {
                    firstViewedAt: now,
                    weekBucket,
                    monthBucket,
                },
            },
            { upsert: true },
        );

        return Boolean(result?.upsertedCount) || Boolean(result?.upsertedId);
    } catch (error) {
        // Duplicate key means another concurrent request already inserted the unique record.
        if (error?.code === 11000) {
            return false;
        }
        throw error;
    }
};

export const likeVideo = async (req, res) => {
    try {
        const userId = req.user?.id;
        const videoId = req.params.id;

        if (!userId) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const video = await Content.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        // Check if user already has a reaction - O(log N) indexed lookup
        const existingReaction = await VideoReaction.findOne({
            videoId,
            userId
        });

        if (existingReaction) {
            if (existingReaction.type === 'like') {
                // User already liked, remove like (unlike)
                await VideoReaction.deleteOne({ _id: existingReaction._id });
                video.likeCount = Math.max(0, (video.likeCount || 1) - 1);
                await video.save();
                return res.json({
                    message: "Like removed",
                    liked: false,
                    likes: video.likeCount,
                    dislikes: video.dislikeCount,
                    userReaction: null
                });
            } else {
                // User disliked before, change to like
                existingReaction.type = 'like';
                await existingReaction.save();
                video.dislikeCount = Math.max(0, (video.dislikeCount || 1) - 1);
                video.likeCount = (video.likeCount || 0) + 1;
                await video.save();
                return res.json({
                    message: "Changed to like",
                    liked: true,
                    likes: video.likeCount,
                    dislikes: video.dislikeCount,
                    userReaction: 'like'
                });
            }
        } else {
            // Add new like
            await VideoReaction.create({
                videoId,
                userId,
                type: 'like'
            });
            video.likeCount = (video.likeCount || 0) + 1;
            await video.save();
            return res.json({
                message: "Video liked",
                liked: true,
                likes: video.likeCount,
                dislikes: video.dislikeCount,
                userReaction: 'like'
            });
        }

    } catch (error) {
        console.error("Error liking video:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

export const dislikeVideo = async (req, res) => {
    try {
        const userId = req.user?.id;
        const videoId = req.params.id;

        if (!userId) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const video = await Content.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        // Check if user already has a reaction - O(log N) indexed lookup
        const existingReaction = await VideoReaction.findOne({
            videoId,
            userId
        });

        if (existingReaction) {
            if (existingReaction.type === 'dislike') {
                // User already disliked, remove dislike
                await VideoReaction.deleteOne({ _id: existingReaction._id });
                video.dislikeCount = Math.max(0, (video.dislikeCount || 1) - 1);
                await video.save();
                return res.json({
                    message: "Dislike removed",
                    disliked: false,
                    likes: video.likeCount,
                    dislikes: video.dislikeCount,
                    userReaction: null
                });
            } else {
                // User liked before, change to dislike
                existingReaction.type = 'dislike';
                await existingReaction.save();
                video.likeCount = Math.max(0, (video.likeCount || 1) - 1);
                video.dislikeCount = (video.dislikeCount || 0) + 1;
                await video.save();
                return res.json({
                    message: "Changed to dislike",
                    disliked: true,
                    likes: video.likeCount,
                    dislikes: video.dislikeCount,
                    userReaction: 'dislike'
                });
            }
        } else {
            // Add new dislike
            await VideoReaction.create({
                videoId,
                userId,
                type: 'dislike'
            });
            video.dislikeCount = (video.dislikeCount || 0) + 1;
            await video.save();
            return res.json({
                message: "Video disliked",
                disliked: true,
                likes: video.likeCount,
                dislikes: video.dislikeCount,
                userReaction: 'dislike'
            });
        }

    } catch (error) {
        console.error("Error disliking video:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

export const subscribeToUser = async (req, res) => {
    try {
        const userId = req.user?.id;
        const targetUserId = req.params.userId;

        const user = await User.findById(userId);
        const targetUser = await User.findById(targetUserId);

        if (!user || !targetUser) {
            return res.status(404).json({ message: "User not found" });
        }

        // Initialize subscriptions array if not exists
        if (!user.subscriptions) {
            user.subscriptions = [];
        }

        // Check if already subscribed
        const isSubscribed = user.subscriptions.includes(targetUserId);

        if (isSubscribed) {
            // Unsubscribe
            user.subscriptions = user.subscriptions.filter(id => id.toString() !== targetUserId);
            await user.save();

            res.json({
                message: "Unsubscribed successfully",
                subscribed: false,
                subscriberCount: user.subscriptions.length
            });
        } else {
            // Subscribe
            user.subscriptions.push(targetUserId);
            await user.save();

            res.json({
                message: "Subscribed successfully",
                subscribed: true,
                subscriberCount: user.subscriptions.length
            });
        }

    } catch (error) {
        console.error("Error subscribing:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

export const updateWatchTime = async (req, res) => {
    try {
        const videoId = req.params.id;
        const { watchTime } = req.body;
        const userId = req.user?.id;

        console.log('🔍 updateWatchTime called:', { videoId, watchTime, userId });

        if (!userId) {
            console.log('❌ No user ID found');
            return res.status(401).json({ message: "Authentication required" });
        }

        const watchTimeMs = Number(watchTime);
        if (!Number.isFinite(watchTimeMs) || watchTimeMs <= 0) {
            console.log('❌ Invalid watchTime:', watchTime);
            return res.status(400).json({ message: "Invalid watch time" });
        }

        const video = await Content.findById(videoId);
        if (!video) {
            console.log('❌ Video not found:', videoId);
            return res.status(404).json({ message: "Video not found" });
        }

        console.log('✅ Found video:', video.title, 'duration:', video.duration);

        // Convert to seconds
        const watchTimeSeconds = watchTimeMs / 1000;
        if (!Number.isFinite(watchTimeSeconds) || watchTimeSeconds <= 0) {
            console.log('❌ Invalid watchTime seconds:', watchTimeSeconds);
            return res.status(400).json({ message: "Invalid watch time" });
        }
        console.log('🔄 Converted watchTime to seconds:', watchTimeSeconds);

        // Constraints to reduce outliers and bot effects
        // Dynamic MIN_WATCH_TIME: shorter threshold for short videos
        const parsedDuration = Number(video.duration);
        const duration = Number.isFinite(parsedDuration) && parsedDuration > 0
            ? parsedDuration
            : 0;
        // Use bracket system for all constraints — every duration range covered
        const bracket = getBracket(duration);
        const MIN_WATCH_TIME = bracket.minWatch;
        const MAX_WATCH_TIME = bracket.maxWatch;

        console.log('📊 Constraints (bracket):', { MIN_WATCH_TIME, MAX_WATCH_TIME, videoDuration: duration, viewThreshold: bracket.viewThreshold, cooldownMs: bracket.cooldownMs });

        // Skip only if watch time is below minimum or above maximum
        if (watchTimeSeconds < MIN_WATCH_TIME ||
            watchTimeSeconds > MAX_WATCH_TIME) {
            console.log('⚠️ Watch time not counted due to constraints - watch time outlier');
            console.log('📊 Skipped update details:', {
                videoDuration: duration,
                watchTimeSeconds,
                minWatch: MIN_WATCH_TIME,
                maxWatch: MAX_WATCH_TIME
            });
            return res.json({
                message: "Watch time not counted (outlier)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }

        // Check for bot-like behavior: rapid successive watches
        const recentWatchKey = `${userId}_${videoId}`;
        const now = Date.now();
        const cacheEntry = watchRateLimit.get(recentWatchKey) || { lastWatch: 0 };

        const minUpdateGapMs = getMinWatchUpdateGapMs(duration);
        if (now - cacheEntry.lastWatch < minUpdateGapMs) {
            console.log('⚠️ Watch time not counted due to rate limiting - too frequent updates');
            console.log('📊 Rate limit details:', {
                timeSinceLastWatch: now - cacheEntry.lastWatch,
                limit: minUpdateGapMs,
                userId,
                videoId
            });
            return res.json({
                message: "Watch time not counted (too frequent)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }

        // Update rate limit cache
        watchRateLimit.set(recentWatchKey, { lastWatch: now });

        // Update total watch time
        console.log('📊 Before update:', {
            currentTotalWatchTime: video.totalWatchTime || 0,
            currentViews: video.views || 0,
            currentAverageWatchTime: video.averageWatchTime || 0,
            incomingWatchTimeSeconds: watchTimeSeconds
        });

        const currentTotalWatchTime = Number(video.totalWatchTime);
        video.totalWatchTime = (Number.isFinite(currentTotalWatchTime) ? currentTotalWatchTime : 0) + watchTimeSeconds;

        console.log('💾 Saving video with updated stats:', {
            newTotalWatchTime: video.totalWatchTime,
            newViews: video.views,
            newAverageWatchTime: video.averageWatchTime,
            calculation: `${video.totalWatchTime} / ${video.views || 0} = ${video.averageWatchTime}`
        });

        await video.save();

        // View counting logic
        const threshold = getViewThresholdSeconds(duration);

        console.log('📊 View counting check:', { watchTimeSeconds, threshold, duration });

        if (watchTimeSeconds >= threshold) {
            console.log('✅ Threshold met, checking user and last view...');
            const user = await User.findById(userId);
            if (user) {
                console.log('✅ User found, checking last view entry...');
                if (!Array.isArray(user.viewHistory)) {
                    user.viewHistory = [];
                }

                const lastViewEntry = user.viewHistory.find(v => v.videoId.toString() === videoId);
                let canCountView = true;
                const requestMeta = {
                    lastViewedAt: new Date(now),
                    ipAddress: req.ip || req.connection.remoteAddress,
                    userAgent: req.get('User-Agent')
                };

                if (lastViewEntry) {
                    // Hard boundary: once a user has a viewHistory record for the same video,
                    // never increment view again.
                    canCountView = false;
                    console.log('⚠️ View not counted - existing user viewHistory entry (one-view-per-user policy)');

                    // Keep metadata fresh without affecting view count.
                    lastViewEntry.lastViewedAt = requestMeta.lastViewedAt;
                    lastViewEntry.ipAddress = requestMeta.ipAddress;
                    lastViewEntry.userAgent = requestMeta.userAgent;
                    await user.save();
                }

                if (canCountView) {
                    // Race-safe final guard: only first upsert can count as a view.
                    let uniqueViewCreated = false;
                    try {
                        uniqueViewCreated = await ensureUniqueContentView({
                            contentId: videoId,
                            userId,
                            now: new Date(now),
                        });
                    } catch (contentViewError) {
                        console.error('⚠️ ContentView upsert failed:', contentViewError.message);
                        uniqueViewCreated = false;
                    }

                    if (uniqueViewCreated) {
                        console.log('✅ Counting view...');

                        const safeViews = Number.isFinite(Number(video.views))
                            ? Number(video.views)
                            : 0;
                        video.views = safeViews + 1;
                        video.averageWatchTime = video.views > 0
                            ? video.totalWatchTime / video.views
                            : 0;

                        user.viewHistory.push({
                            videoId: videoId,
                            lastViewedAt: requestMeta.lastViewedAt,
                            ipAddress: requestMeta.ipAddress,
                            userAgent: requestMeta.userAgent
                        });

                        await user.save();
                        await video.save();

                        console.log('✅ View counted successfully');
                        console.log('📊 View stats:', {
                            newViews: video.views,
                            newAverageWatchTime: video.averageWatchTime,
                            videoId,
                            userId
                        });
                    } else {
                        // Backfill viewHistory when unique view already exists (legacy data / cleared history)
                        // so future requests short-circuit without another ContentView upsert attempt.
                        const hasViewHistoryEntry = user.viewHistory.some(
                            (entry) => entry?.videoId?.toString() === videoId,
                        );
                        if (!hasViewHistoryEntry) {
                            user.viewHistory.push({
                                videoId: videoId,
                                lastViewedAt: requestMeta.lastViewedAt,
                                ipAddress: requestMeta.ipAddress,
                                userAgent: requestMeta.userAgent,
                            });
                            await user.save();
                        }

                        console.log('⚠️ View not counted - unique ContentView already exists for this user+video');
                    }
                } else {
                    console.log('⚠️ View not counted due to one-view boundary conditions');
                }
            } else {
                console.log('❌ User not found for view counting');
            }
        } else {
            console.log('⚠️ View not counted - threshold not met');
        }

        console.log('✅ Watch time updated successfully');
        console.log('📊 Final stats:', {
            totalWatchTime: video.totalWatchTime,
            views: video.views,
            averageWatchTime: video.averageWatchTime,
            videoId,
            userId
        });

        // ═══ Upsert WatchHistory for recommendation engine + history page ═══
        try {
            const user = await User.findById(userId, 'historyPaused') || {};
            if (!user.historyPaused) {
                const watchPercentage = video.duration > 0
                    ? Math.min(100, (watchTimeSeconds / video.duration) * 100) : 0;
                const completedWatch = watchPercentage >= 80;
                const existingHistory = await WatchHistory.findOne({ userId, contentId: videoId });
                const isNewEntry = !existingHistory;

                await WatchHistory.findOneAndUpdate(
                    { userId, contentId: videoId },
                    {
                        $set: {
                            contentType: 'video',
                            lastWatchedAt: new Date(),
                            watchPercentage: Math.max(watchPercentage, existingHistory?.watchPercentage || 0),
                            completedWatch: completedWatch || existingHistory?.completedWatch || false,
                            'contentMetadata.title': video.title,
                            'contentMetadata.tags': video.tags || [],
                            'contentMetadata.category': video.category,
                            'contentMetadata.creatorId': video.userId,
                            'contentMetadata.duration': video.duration
                        },
                        $inc: {
                            watchTime: watchTimeSeconds,
                            watchCount: 1
                        },
                        $setOnInsert: {
                            firstWatchedAt: new Date()
                        },
                        $push: {
                            sessions: {
                                $each: [{
                                    startedAt: new Date(Date.now() - watchTimeMs),
                                    endedAt: new Date(),
                                    watchTime: watchTimeSeconds,
                                    completedWatch
                                }],
                                $slice: -20
                            }
                        }
                    },
                    { upsert: true, new: true }
                );

                // Cap history at 100 entries per user
                if (isNewEntry) {
                    const historyCount = await WatchHistory.countDocuments({ userId });
                    if (historyCount > 100) {
                        const oldest = await WatchHistory.find({ userId })
                            .sort({ lastWatchedAt: 1 })
                            .limit(historyCount - 100)
                            .select('_id');
                        await WatchHistory.deleteMany({ _id: { $in: oldest.map(h => h._id) } });
                    }
                }

                console.log(`📝 [WatchHistory] Video upserted - userId: ${userId}, videoId: ${videoId}, watchPercentage: ${watchPercentage.toFixed(1)}%`);
            } else {
                console.log(`⏸️ [WatchHistory] Skipped - history paused for user ${userId}`);
            }
        } catch (historyErr) {
            console.error('⚠️ WatchHistory upsert failed (non-blocking):', historyErr.message);
        }

        res.json({
            message: "Watch time updated",
            averageWatchTime: video.averageWatchTime,
            views: video.views,
            totalWatchTime: video.totalWatchTime
        });

    } catch (error) {
        console.error("💥 Error updating watch time:", error);
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};
