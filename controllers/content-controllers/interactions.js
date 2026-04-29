/**
 * interactions.js — VIDEO engagement & watch time tracking
 *
 * View counting: min(30s, 30% of duration) threshold.
 * Supports both authenticated (userId) and anonymous (IP+fingerprint) viewers.
 * View counts are batched via viewCountQueue and flushed every 10s.
 * Cooldown dedup uses ContentView.lastCountedAt instead of user.viewHistory.
 */
import crypto from 'crypto';
import Content from "../../models/content.model.js";
import User from "../../models/user.model.js";
import VideoReaction from "../../models/videoReaction.model.js";
import WatchHistory from "../../models/watchHistory.model.js";
import ContentView from "../../models/contentView.model.js";
import { incrementView } from "../../utils/viewCountQueue.js";

// In-memory rate limiting (resets on server restart — acceptable for throttling)
const watchRateLimit = new Map();

/**
 * Compute a visitor fingerprint for anonymous users.
 */
const computeFingerprint = (req) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const ua = req.get('User-Agent') || '';
    const lang = req.get('Accept-Language') || '';
    return crypto.createHash('sha256').update(`${ip}|${ua}|${lang}`).digest('hex');
};

/**
 * View threshold: min(30s, 30% of duration), minimum 1s.
 */
const getViewThreshold = (durationSeconds = 0) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 5;
    return Math.max(1, Math.min(30, durationSeconds * 0.3));
};

/**
 * Rate limit gap between watch-time updates (ms).
 */
const getMinUpdateGapMs = (durationSeconds = 0) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 10000;
    if (durationSeconds <= 10) return 3000;
    if (durationSeconds <= 60) return 5000;
    if (durationSeconds <= 600) return 10000;
    return 15000;
};

/**
 * View recount cooldown: max(duration × 5, 30s) in ms.
 */
const getViewRecountCooldownMs = (durationSeconds = 0) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 5 * 60 * 1000;
    return Math.max(durationSeconds * 5 * 1000, 30 * 1000);
};

/**
 * Max acceptable watch time per update: 1.5× duration or 1hr fallback.
 */
const getMaxWatchTime = (durationSeconds = 0) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 3600;
    return durationSeconds * 1.5;
};

const buildViewBuckets = (now = new Date()) => {
    const year = now.getFullYear();
    const week = Math.ceil(((now - new Date(year, 0, 1)) / 86400000 + 1) / 7);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return {
        weekBucket: `${year}-W${String(week).padStart(2, '0')}`,
        monthBucket: `${year}-${month}`,
    };
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
        const userId = req.user?.id || null;

        // Support both authenticated and anonymous viewers
        const fingerprint = !userId ? computeFingerprint(req) : null;
        const viewerKey = userId || fingerprint;

        if (!viewerKey) {
            return res.status(400).json({ message: "Unable to identify viewer" });
        }

        const watchTimeMs = Number(watchTime);
        if (!Number.isFinite(watchTimeMs) || watchTimeMs <= 0) {
            return res.status(400).json({ message: "Invalid watch time" });
        }

        const video = await Content.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        const watchTimeSeconds = watchTimeMs / 1000;
        if (!Number.isFinite(watchTimeSeconds) || watchTimeSeconds <= 0) {
            return res.status(400).json({ message: "Invalid watch time" });
        }

        const parsedDuration = Number(video.duration);
        const duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 0;
        const MIN_WATCH = Math.max(1, duration > 0 ? Math.min(5, duration * 0.1) : 1);
        const MAX_WATCH = getMaxWatchTime(duration);

        if (watchTimeSeconds < MIN_WATCH || watchTimeSeconds > MAX_WATCH) {
            return res.json({
                message: "Watch time not counted (outlier)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }

        // Rate limiting (in-memory, keyed by viewer+video)
        const rateLimitKey = `${viewerKey}_${videoId}`;
        const now = Date.now();
        const cacheEntry = watchRateLimit.get(rateLimitKey) || { lastWatch: 0 };
        const minGap = getMinUpdateGapMs(duration);

        if (now - cacheEntry.lastWatch < minGap) {
            return res.json({
                message: "Watch time not counted (too frequent)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }
        watchRateLimit.set(rateLimitKey, { lastWatch: now });

        // Accumulate total watch time atomically
        await Content.updateOne(
            { _id: videoId },
            { $inc: { totalWatchTime: watchTimeSeconds } }
        );

        // ── View counting logic ──
        const threshold = getViewThreshold(duration);

        if (watchTimeSeconds >= threshold) {
            // Build the query to find this viewer's ContentView record
            const viewQuery = userId
                ? { contentId: videoId, userId }
                : { contentId: videoId, visitorFingerprint: fingerprint };

            const existingView = await ContentView.findOne(viewQuery).lean();
            const viewCooldownMs = getViewRecountCooldownMs(duration);
            const lastCountedMs = existingView?.lastCountedAt
                ? new Date(existingView.lastCountedAt).getTime() : 0;
            const timeSinceLast = Number.isFinite(lastCountedMs) && lastCountedMs > 0
                ? now - lastCountedMs : Infinity;
            const canCountView = !existingView || timeSinceLast >= viewCooldownMs;

            const { weekBucket, monthBucket } = buildViewBuckets(new Date(now));

            if (canCountView) {
                // Batch the view increment (flushed every 10s)
                incrementView(videoId);

                // Upsert ContentView with lastCountedAt
                const upsertData = userId
                    ? { contentId: videoId, userId }
                    : { contentId: videoId, visitorFingerprint: fingerprint };

                await ContentView.updateOne(
                    upsertData,
                    {
                        $set: { lastCountedAt: new Date(now) },
                        $inc: { viewCount: 1 },
                        $setOnInsert: {
                            firstViewedAt: new Date(now),
                            weekBucket, monthBucket,
                            ipAddress: !userId ? (req.ip || req.headers['x-forwarded-for'] || '') : undefined,
                        },
                    },
                    { upsert: true }
                );

                // Recalculate averageWatchTime
                const updatedVideo = await Content.findById(videoId).select('views totalWatchTime').lean();
                if (updatedVideo && updatedVideo.views > 0) {
                    await Content.updateOne(
                        { _id: videoId },
                        { $set: { averageWatchTime: updatedVideo.totalWatchTime / updatedVideo.views } }
                    );
                }
            } else {
                // Analytics-only upsert (no view count, no lastCountedAt update)
                if (userId) {
                    await ContentView.updateOne(
                        { contentId: videoId, userId },
                        { $setOnInsert: { firstViewedAt: new Date(now), weekBucket, monthBucket } },
                        { upsert: true }
                    ).catch(() => {});
                }
            }
        }

        // ── WatchHistory upsert (authenticated users only) ──
        if (userId) {
            try {
                const historyUser = await User.findById(userId, 'historyPaused').lean();
                if (!historyUser?.historyPaused) {
                    const watchPct = duration > 0 ? Math.min(100, (watchTimeSeconds / duration) * 100) : 0;
                    const completed = watchPct >= 80;
                    const existing = await WatchHistory.findOne({ userId, contentId: videoId });
                    const isNew = !existing;

                    await WatchHistory.findOneAndUpdate(
                        { userId, contentId: videoId },
                        {
                            $set: {
                                contentType: 'video',
                                lastWatchedAt: new Date(),
                                watchPercentage: Math.max(watchPct, existing?.watchPercentage || 0),
                                completedWatch: completed || existing?.completedWatch || false,
                                'contentMetadata.title': video.title,
                                'contentMetadata.tags': video.tags || [],
                                'contentMetadata.category': video.category,
                                'contentMetadata.creatorId': video.userId,
                                'contentMetadata.duration': video.duration
                            },
                            $inc: { watchTime: watchTimeSeconds, watchCount: 1 },
                            $setOnInsert: { firstWatchedAt: new Date() },
                            $push: {
                                sessions: {
                                    $each: [{
                                        startedAt: new Date(Date.now() - watchTimeMs),
                                        endedAt: new Date(),
                                        watchTime: watchTimeSeconds,
                                        completedWatch: completed
                                    }],
                                    $slice: -20
                                }
                            }
                        },
                        { upsert: true, new: true }
                    );

                    if (isNew) {
                        const count = await WatchHistory.countDocuments({ userId });
                        if (count > 100) {
                            const oldest = await WatchHistory.find({ userId })
                                .sort({ lastWatchedAt: 1 }).limit(count - 100).select('_id');
                            await WatchHistory.deleteMany({ _id: { $in: oldest.map(h => h._id) } });
                        }
                    }
                }
            } catch (historyErr) {
                // Non-blocking
            }
        }

        const freshVideo = await Content.findById(videoId).select('averageWatchTime views totalWatchTime').lean();
        res.json({
            message: "Watch time updated",
            averageWatchTime: freshVideo?.averageWatchTime || 0,
            views: freshVideo?.views || 0,
            totalWatchTime: freshVideo?.totalWatchTime || 0
        });

    } catch (error) {
        console.error("Error updating watch time:", error);
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};
