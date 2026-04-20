/**
 * Shared Content Controller
 * Handles: get content, upload thumbnail, feed content, single content
 * Shared functions used by all content types
 *
 * ═══════════════════════════════════════════════════════════
 * HOW VIEWS ARE COUNTED (for SHORTS, AUDIO, POSTS):
 * ═══════════════════════════════════════════════════════════
 * 1. Frontend sends watch time to POST /api/v2/content/:id/watch-time.
 * 2. Backend applies the same bracket policy used by videos:
 *    - dynamic min watch, max watch (outlier protection), and update gap.
 * 3. totalWatchTime always accumulates for valid updates.
 * 4. A view is counted only when threshold is met AND per-user cooldown passes.
 * 5. Cooldown is per user+content: ~5x duration (with safe fallback for unknown duration).
 * 6. user.viewHistory.lastViewedAt is used as the repeat-view gate.
 * 7. ContentView upsert is analytics-only (unique viewers), not a hard block.
 * 8. Posts support click/open view counting by allowing 1s first-threshold events.
 *
 * ═══════════════════════════════════════════════════════════
 * HOW WATCH HISTORY IS TRACKED:
 * ═══════════════════════════════════════════════════════════
 * - Every watchTime update upserts a WatchHistory record for that user+content.
 * - WatchHistory stores: watchTime, watchPercentage, completedWatch (>=80%),
 *   contentMetadata snapshot (title, tags, category, creatorId, duration),
 *   and up to 20 session records.
 * - The watchHistoryRecommendation.js engine uses this data to build
 *   personalized feeds (preferred tags, categories, creators).
 * ═══════════════════════════════════════════════════════════
 */

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import Comment from '../../models/comment.model.js';
import WatchHistory from '../../models/watchHistory.model.js';
import User from '../../models/user.model.js';
import ContentView from '../../models/contentView.model.js';
import ContentReport from '../../models/contentReport.model.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getCfUrl } from '../../config/cloudfront.js';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Upload custom thumbnail for content (shorts/audio)
 */
export const uploadThumbnail = async (req, res) => {
    try {
        const { id: contentId } = req.params;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ error: 'User not authenticated' });
        if (!mongoose.Types.ObjectId.isValid(contentId)) return res.status(400).json({ error: 'Invalid content ID' });

        const content = await Content.findById(contentId);
        if (!content) return res.status(404).json({ error: 'Content not found' });
        if (content.userId.toString() !== userId) return res.status(403).json({ error: 'Not authorized' });
        if (!req.file && !req.files?.thumbnail) return res.status(400).json({ error: 'No thumbnail file provided' });

        const file = req.file || req.files.thumbnail[0];
        const contentTypeFolder = content.contentType === 'short' ? 'shorts' : content.contentType;
        const thumbnailKey = `thumbnails/${contentTypeFolder}/${userId}/${contentId}_thumb.${file.mimetype.split('/')[1] || 'jpg'}`;

        await s3Client.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: thumbnailKey, Body: file.buffer, ContentType: file.mimetype }));
        await Content.findByIdAndUpdate(contentId, { thumbnailKey, thumbnailSource: 'custom' });

        console.log(`✅ Custom thumbnail uploaded for content: ${contentId}`);
        res.json({ success: true, message: 'Thumbnail uploaded successfully', thumbnailKey });
    } catch (error) {
        console.error('❌ Error uploading thumbnail:', error);
        res.status(500).json({ error: 'Failed to upload thumbnail' });
    }
};

/**
 * Get content by ID (shorts/audio/posts)
 */
export const getContent = async (req, res) => {
    try {
        const { id: contentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(contentId)) return res.status(400).json({ error: 'Invalid content ID' });

        const content = await Content.findById(contentId).populate('userId', 'userName channelName channelHandle channelPicture profilePicture');
        if (!content) return res.status(404).json({ error: 'Content not found' });

        const thumbnailUrl = getCfUrl(content.thumbnailKey);
        const imageUrl = getCfUrl(content.imageKey);
        let audioUrl = null;
        if (content.contentType === 'audio' && content.originalKey) {
            audioUrl = getCfUrl(content.originalKey);
        }

        res.json({
            _id: content._id, contentType: content.contentType, title: content.title,
            description: content.description, postContent: content.postContent,
            duration: content.duration, thumbnailUrl, imageUrl, audioUrl,
            status: content.status, views: content.views, likeCount: content.likeCount,
            dislikeCount: content.dislikeCount, createdAt: content.createdAt,
            user: content.userId, channelName: content.channelName,
            tags: content.tags, category: content.category,
            audioCategory: content.audioCategory, artist: content.artist, album: content.album,
            visibility: content.visibility, commentsEnabled: content.commentsEnabled
        });
    } catch (error) {
        console.error('❌ Error fetching content:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get user's content (shorts, audio, posts)
 */
export const getUserContent = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'User not authenticated' });

        const { type, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const query = { userId, contentType: { $in: ['short', 'audio', 'post'] } };
        if (type && ['short', 'audio', 'post'].includes(type)) query.contentType = type;

        const [contents, total] = await Promise.all([
            Content.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
            Content.countDocuments(query)
        ]);

        const contentsWithUrls = await Promise.all(contents.map(async (content) => ({
            _id: content._id, contentType: content.contentType, title: content.title,
            description: content.description, status: content.status, createdAt: content.createdAt,
            thumbnailUrl: getCfUrl(content.thumbnailKey),
            views: content.views, likeCount: content.likeCount
        })));

        res.json({
            contents: contentsWithUrls,
            pagination: { currentPage: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)), totalItems: total, hasNextPage: skip + parseInt(limit) < total }
        });
    } catch (error) {
        console.error('❌ Error fetching user content:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get feed content (shorts, posts from subscriptions or trending)
 */
export const getFeedContent = async (req, res) => {
    try {
        const { type, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const query = { status: 'completed', visibility: 'public' };
        if (type && ['short', 'audio', 'post'].includes(type)) {
            query.contentType = type;
        } else {
            query.contentType = { $in: ['short', 'audio', 'post'] };
        }

        const contents = await Content.find(query)
            .populate('userId', 'userName channelName channelHandle channelPicture')
            .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
        const total = await Content.countDocuments(query);

        const contentsWithUrls = await Promise.all(contents.map(async (content) => {
            const commentCount = await Comment.countDocuments({ videoId: content._id, onModel: 'Content', parentCommentId: null });
            return {
                _id: content._id, contentType: content.contentType, title: content.title,
                description: content.description, postContent: content.postContent,
                duration: content.duration,
                thumbnailUrl: getCfUrl(content.thumbnailKey),
                imageUrl: getCfUrl(content.imageKey),
                views: content.views, likeCount: content.likeCount, commentCount,
                createdAt: content.createdAt, user: content.userId, channelName: content.channelName
            };
        }));

        res.json({
            contents: contentsWithUrls,
            pagination: { currentPage: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)), totalItems: total, hasNextPage: skip + parseInt(limit) < total }
        });
    } catch (error) {
        console.error('❌ Error fetching feed:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get single content item by ID (with all URLs)
 */
export const getSingleContent = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid content ID' });

        const content = await Content.findById(id).populate('userId', 'userName channelName channelHandle channelPicture');
        if (!content) return res.status(404).json({ error: 'Content not found' });
        if (content.status === 'removed') return res.status(410).json({ error: 'This content has been removed and is no longer available' });

        const commentCount = await Comment.countDocuments({ videoId: content._id, onModel: 'Content', parentCommentId: null });
        const thumbnailUrl = getCfUrl(content.thumbnailKey);
        const imageUrl = getCfUrl(content.imageKey);

        let imageUrls = [];
        if (content.contentType === 'post' && content.imageKeys?.length > 0) {
            imageUrls = (await Promise.all(content.imageKeys.map(key => getCfUrl(key)))).filter(Boolean);
        } else if (imageUrl) {
            imageUrls = [imageUrl];
        }

        let mediaUrl = null;
        if (content.contentType === 'short') {
            const videoKey = content.hlsKey || content.processedKey || content.originalKey;
            mediaUrl = getCfUrl(videoKey);
        } else if (content.contentType === 'audio') {
            const audioKey = content.processedKey || content.originalKey;
            mediaUrl = getCfUrl(audioKey);
        }

        res.json({
            _id: content._id, contentType: content.contentType, title: content.title,
            description: content.description, postContent: content.postContent,
            duration: content.duration, thumbnailUrl,
            imageUrl: imageUrl || thumbnailUrl, imageUrls,
            videoUrl: content.contentType === 'short' ? mediaUrl : null,
            audioUrl: content.contentType === 'audio' ? mediaUrl : null,
            views: content.views, likeCount: content.likeCount || 0, commentCount,
            createdAt: content.createdAt,
            channelName: content.channelName || content.userId?.channelName || content.userId?.userName,
            channelPicture: content.userId?.channelPicture,
            userId: content.userId?._id || content.userId,
            tags: content.tags, category: content.category,
            artist: content.artist, album: content.album, audioCategory: content.audioCategory,
            visibility: content.visibility, status: content.status
        });
    } catch (error) {
        console.error('❌ Error fetching content:', error);
        res.status(500).json({ error: 'Failed to fetch content' });
    }
};

/**
 * Update content engagement (like, dislike) for shorts/audio/posts
 * Uses VideoReaction model for proper per-user toggle logic (same as WatchPage)
 */
export const updateContentEngagement = async (req, res) => {
    try {
        const { id } = req.params;
        const action = req.body.action || req.body.type; // accept both 'action' and 'type'
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ error: 'Authentication required' });
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid content ID' });
        if (!['like', 'dislike'].includes(action)) return res.status(400).json({ error: 'Invalid action. Must be "like" or "dislike"' });

        const content = await Content.findById(id);
        if (!content) return res.status(404).json({ error: 'Content not found' });

        const VideoReaction = (await import('../../models/videoReaction.model.js')).default;
        const existingReaction = await VideoReaction.findOne({ videoId: id, userId });

        if (existingReaction) {
            if (existingReaction.type === action) {
                // Same action again → remove reaction (toggle off)
                await VideoReaction.deleteOne({ _id: existingReaction._id });
                if (action === 'like') {
                    content.likeCount = Math.max(0, (content.likeCount || 1) - 1);
                } else {
                    content.dislikeCount = Math.max(0, (content.dislikeCount || 1) - 1);
                }
                await content.save();
                return res.json({
                    success: true,
                    likes: content.likeCount || 0,
                    dislikes: content.dislikeCount || 0,
                    userReaction: null
                });
            } else {
                // Different action → switch reaction
                existingReaction.type = action;
                await existingReaction.save();
                if (action === 'like') {
                    content.likeCount = (content.likeCount || 0) + 1;
                    content.dislikeCount = Math.max(0, (content.dislikeCount || 1) - 1);
                } else {
                    content.dislikeCount = (content.dislikeCount || 0) + 1;
                    content.likeCount = Math.max(0, (content.likeCount || 1) - 1);
                }
                await content.save();
                return res.json({
                    success: true,
                    likes: content.likeCount || 0,
                    dislikes: content.dislikeCount || 0,
                    userReaction: action
                });
            }
        } else {
            // No existing reaction → create new
            await VideoReaction.create({ videoId: id, userId, type: action });
            if (action === 'like') {
                content.likeCount = (content.likeCount || 0) + 1;
            } else {
                content.dislikeCount = (content.dislikeCount || 0) + 1;
            }
            await content.save();
            return res.json({
                success: true,
                likes: content.likeCount || 0,
                dislikes: content.dislikeCount || 0,
                userReaction: action
            });
        }
    } catch (error) {
        console.error('❌ Error updating engagement:', error);
        res.status(500).json({ error: 'Failed to update engagement' });
    } finally {
        // Sync engagement to WatchHistory (fire-and-forget for speed)
        try {
            const WatchHistory = (await import('../../models/watchHistory.model.js')).default;
            const finalReaction = await (await import('../../models/videoReaction.model.js')).default
                .findOne({ videoId: id, userId: req.user?.id });
            await WatchHistory.findOneAndUpdate(
                { userId: req.user?.id, contentId: id },
                {
                    $set: {
                        liked: finalReaction?.type === 'like',
                        disliked: finalReaction?.type === 'dislike'
                    }
                },
                { upsert: false } // Only update if WatchHistory entry exists
            );
        } catch (_) { /* non-critical */ }
    }
};

// In-memory rate limiter: userId:contentId -> last update timestamp
const watchTimeRateLimit = new Map();

const DURATION_BRACKETS = [
    { maxDuration: 5, viewThreshold: 1, cooldownMs: 2000, minWatch: 1, maxWatchFallback: 7.5 },
    { maxDuration: 10, viewThreshold: 2, cooldownMs: 3000, minWatch: 1, maxWatchFallback: 15 },
    { maxDuration: 30, viewThreshold: 5, cooldownMs: 5000, minWatch: 5, maxWatchFallback: 45 },
    { maxDuration: 60, viewThreshold: 5, cooldownMs: 5000, minWatch: 5, maxWatchFallback: 90 },
    { maxDuration: 300, viewThreshold: 10, cooldownMs: 10000, minWatch: 5, maxWatchFallback: 450 },
    { maxDuration: 600, viewThreshold: 15, cooldownMs: 10000, minWatch: 5, maxWatchFallback: 900 },
    { maxDuration: 1800, viewThreshold: 30, cooldownMs: 15000, minWatch: 5, maxWatchFallback: 2700 },
    { maxDuration: 3600, viewThreshold: 30, cooldownMs: 15000, minWatch: 5, maxWatchFallback: 5400 },
    { maxDuration: Infinity, viewThreshold: 30, cooldownMs: 15000, minWatch: 5, maxWatchFallback: null },
];

const UNKNOWN_DURATION_BRACKET = { viewThreshold: 5, cooldownMs: 10000, minWatch: 5, maxWatch: 3600 };

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

    return UNKNOWN_DURATION_BRACKET;
};

const getMinWatchUpdateGapMs = (durationSeconds = 0) => getBracket(durationSeconds).cooldownMs;

const getViewThresholdSeconds = (contentType, durationSeconds = 0) => {
    if (contentType === 'post') {
        return 1;
    }
    return getBracket(durationSeconds).viewThreshold;
};

const getMinWatchSeconds = (contentType, durationSeconds = 0) => {
    if (contentType === 'post') {
        return 1;
    }
    return getBracket(durationSeconds).minWatch;
};

const getMaxWatchSeconds = (durationSeconds = 0) => getBracket(durationSeconds).maxWatch;

const getViewRecountCooldownMs = (durationSeconds = 0) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return 5 * 60 * 1000;
    }

    return Math.max(durationSeconds * 5 * 1000, 30 * 1000);
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
        if (error?.code === 11000) {
            return false;
        }
        throw error;
    }
};

/**
 * Track watch time for shorts/audio/posts
 * - Rate-limited (30s cooldown per user+content)
 * - Minimum watch threshold before counting a view
 * - Writes to WatchHistory so the recommendation algorithm has data
 */
export const updateContentWatchTime = async (req, res) => {
    try {
        const { id } = req.params;
        const { watchTime, duration: clientDuration } = req.body;
        const userId = req.user?.id;

        console.log(`⏱️ [WatchTime] Request - contentId: ${id}, userId: ${userId}, watchTime: ${watchTime}ms`);

        if (!userId) return res.status(401).json({ error: 'Authentication required' });
        const watchTimeMs = Number(watchTime);
        if (!Number.isFinite(watchTimeMs) || watchTimeMs <= 0)
            return res.status(400).json({ error: 'Invalid watch time' });

        const content = await Content.findById(id);
        if (!content) return res.status(404).json({ error: 'Content not found' });

        // FIX: If content has no duration and client sent one, update it.
        // This fixes shorts/audio that were uploaded before duration tracking was added.
        const parsedClientDuration = Number(clientDuration);
        if ((!content.duration || content.duration === 0) && Number.isFinite(parsedClientDuration) && parsedClientDuration > 0) {
            content.duration = parsedClientDuration;
            console.log(`📏 [Duration] Fixed missing duration for ${content.contentType} "${content.title}": ${parsedClientDuration}s`);
        }

        const parsedDuration = Number(content.duration);
        const duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 0;

        const watchTimeSeconds = watchTimeMs / 1000;
        if (!Number.isFinite(watchTimeSeconds) || watchTimeSeconds <= 0) {
            return res.status(400).json({ error: 'Invalid watch time' });
        }

        const minWatchTime = getMinWatchSeconds(content.contentType, duration);
        const maxWatchTime = getMaxWatchSeconds(duration);

        if (watchTimeSeconds < minWatchTime || watchTimeSeconds > maxWatchTime) {
            console.log('⚠️ [WatchTime] Outlier ignored', {
                contentId: id,
                contentType: content.contentType,
                watchTimeSeconds,
                minWatchTime,
                maxWatchTime,
            });
            return res.json({
                message: 'Watch time not counted (outlier)',
                averageWatchTime: content.averageWatchTime || 0,
                views: content.views || 0,
                totalWatchTime: content.totalWatchTime || 0,
                viewCounted: false,
            });
        }

        // Rate limit by duration bracket, same pattern as videos.
        const now = Date.now();
        const rateKey = `${userId}:${id}`;
        const lastUpdate = watchTimeRateLimit.get(rateKey) || 0;
        const minUpdateGapMs = getMinWatchUpdateGapMs(duration);
        if (now - lastUpdate < minUpdateGapMs) {
            console.log('⏸️ [WatchTime] Rate limited - too frequent update', {
                contentId: id,
                userId,
                elapsedMs: now - lastUpdate,
                minUpdateGapMs,
            });
            return res.json({
                message: 'Watch time not counted (too frequent)',
                averageWatchTime: content.averageWatchTime || 0,
                views: content.views || 0,
                totalWatchTime: content.totalWatchTime || 0,
                viewCounted: false,
                rateLimited: true,
            });
        }
        watchTimeRateLimit.set(rateKey, now);

        console.log(`📊 [WatchTime] ${content.contentType} "${content.title}" - ${watchTimeSeconds}s sent, current views: ${content.views}, totalWatchTime: ${content.totalWatchTime || 0}s`);

        // Always accumulate total watch time
        const safeTotalWatchTime = Number(content.totalWatchTime);
        content.totalWatchTime = (Number.isFinite(safeTotalWatchTime) ? safeTotalWatchTime : 0) + watchTimeSeconds;
        await content.save();

        const threshold = getViewThresholdSeconds(content.contentType, duration);

        // Count a view only when threshold and cooldown conditions are satisfied.
        let viewCounted = false;
        if (watchTimeSeconds >= threshold) {
            const viewer = await User.findById(userId);
            if (viewer) {
                if (!Array.isArray(viewer.viewHistory)) {
                    viewer.viewHistory = [];
                }

                const requestMeta = {
                    lastViewedAt: new Date(now),
                    ipAddress: req.ip || req.connection.remoteAddress,
                    userAgent: req.get('User-Agent'),
                };

                const lastViewEntry = viewer.viewHistory.find((entry) => entry?.videoId?.toString() === id);
                const viewCooldownMs = getViewRecountCooldownMs(duration);
                const lastViewedAtMs = lastViewEntry?.lastViewedAt
                    ? new Date(lastViewEntry.lastViewedAt).getTime()
                    : 0;
                const hasValidLastViewedAt = Number.isFinite(lastViewedAtMs) && lastViewedAtMs > 0;
                const timeSinceLastViewMs = hasValidLastViewedAt ? now - lastViewedAtMs : Infinity;
                const canCountView = !lastViewEntry || timeSinceLastViewMs >= viewCooldownMs;

                if (canCountView) {
                    const safeViews = Number.isFinite(Number(content.views))
                        ? Number(content.views)
                        : 0;
                    content.views = safeViews + 1;
                    content.averageWatchTime = content.views > 0
                        ? content.totalWatchTime / content.views
                        : 0;
                    await content.save();
                    viewCounted = true;
                } else {
                    console.log('⚠️ [WatchTime] View not counted - cooldown active', {
                        contentId: id,
                        userId,
                        viewCooldownMs,
                        timeSinceLastViewMs,
                        remainingCooldownMs: Math.max(0, viewCooldownMs - timeSinceLastViewMs),
                    });
                }

                try {
                    await ensureUniqueContentView({
                        contentId: id,
                        userId,
                        now: new Date(now),
                    });
                } catch (contentViewError) {
                    console.error('⚠️ [WatchTime] ContentView upsert failed (non-blocking):', contentViewError.message);
                }

                if (lastViewEntry) {
                    lastViewEntry.lastViewedAt = requestMeta.lastViewedAt;
                    lastViewEntry.ipAddress = requestMeta.ipAddress;
                    lastViewEntry.userAgent = requestMeta.userAgent;
                } else {
                    viewer.viewHistory.push({
                        videoId: id,
                        lastViewedAt: requestMeta.lastViewedAt,
                        ipAddress: requestMeta.ipAddress,
                        userAgent: requestMeta.userAgent,
                    });
                }

                await viewer.save();
            } else {
                console.log('⚠️ [WatchTime] Viewer not found for view counting', { userId, contentId: id });
            }
        } else {
            console.log('⚠️ [WatchTime] View not counted - threshold not met', {
                contentId: id,
                watchTimeSeconds,
                threshold,
                contentType: content.contentType,
            });
        }

        const safeAvgWatchTime = Number.isFinite(Number(content.averageWatchTime)) ? Number(content.averageWatchTime) : 0;
        const safeTotalWatchTimeForLog = Number.isFinite(Number(content.totalWatchTime)) ? Number(content.totalWatchTime) : 0;
        console.log(`✅ [WatchTime] Saved - views: ${content.views}, avgWatchTime: ${safeAvgWatchTime.toFixed(1)}s, viewCounted: ${viewCounted}, totalWatchTime: ${safeTotalWatchTimeForLog.toFixed(1)}s`);

        // Check if user has history tracking paused
        const historyUser = await User.findById(userId, 'historyPaused') || {};
        const historyPaused = historyUser.historyPaused || false;

        if (!historyPaused) {
            // Upsert WatchHistory for the recommendation engine
            const watchPercentage = content.duration > 0
                ? Math.min(100, (watchTimeSeconds / content.duration) * 100) : 0;
            const completedWatch = watchPercentage >= 80;

            const existingHistory = await WatchHistory.findOne({ userId, contentId: id });

            const isNewEntry = !existingHistory;

            await WatchHistory.findOneAndUpdate(
                { userId, contentId: id },
                {
                    $set: {
                        contentType: content.contentType,
                        lastWatchedAt: new Date(),
                        watchPercentage: Math.max(watchPercentage, existingHistory?.watchPercentage || 0),
                        completedWatch: completedWatch || existingHistory?.completedWatch || false,
                        'contentMetadata.title': content.title,
                        'contentMetadata.tags': content.tags || [],
                        'contentMetadata.category': content.category,
                        'contentMetadata.creatorId': content.userId,
                        'contentMetadata.duration': content.duration
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
                                startedAt: new Date(now - watchTimeMs),
                                endedAt: new Date(),
                                watchTime: watchTimeSeconds,
                                completedWatch
                            }],
                            $slice: -20 // Keep last 20 sessions
                        }
                    }
                },
                { upsert: true, new: true }
            );

            // HISTORY CAP: Keep only 100 items per user. If a new entry was created, delete oldest.
            if (isNewEntry) {
                const historyCount = await WatchHistory.countDocuments({ userId });
                if (historyCount > 100) {
                    const oldest = await WatchHistory.find({ userId })
                        .sort({ lastWatchedAt: 1 })
                        .limit(historyCount - 100)
                        .select('_id');
                    await WatchHistory.deleteMany({
                        _id: { $in: oldest.map(h => h._id) }
                    });
                    console.log(`🗑️ [WatchHistory] Trimmed ${historyCount - 100} oldest entries for user ${userId}`);
                }
            }

            console.log(`📝 [WatchHistory] Upserted - userId: ${userId}, contentId: ${id}, watchPercentage: ${(content.duration > 0 ? Math.min(100, (watchTimeSeconds / content.duration) * 100) : 0).toFixed(1)}%, completedWatch: ${watchPercentage >= 80}`);
        } else {
            console.log(`⏸️ [WatchHistory] Skipped - history paused for user ${userId}`);
        }

        res.json({
            message: 'Watch time updated',
            averageWatchTime: content.averageWatchTime,
            views: content.views,
            totalWatchTime: content.totalWatchTime,
            viewCounted
        });
    } catch (error) {
        console.error('❌ Error updating watch time:', error);
        res.status(500).json({ error: 'Failed to update watch time' });
    }
};

/**
 * Get engagement status for a content item
 */
export const getContentEngagementStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;

        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid content ID' });

        const content = await Content.findById(id);
        if (!content) return res.status(404).json({ error: 'Content not found' });

        let userReaction = null;
        let isSubscribed = false;

        if (userId) {
            const VideoReaction = (await import('../../models/videoReaction.model.js')).default;
            const reaction = await VideoReaction.findOne({ videoId: id, userId });
            userReaction = reaction?.type || null;

            const user = await (await import('../../models/user.model.js')).default.findById(userId);
            isSubscribed = user?.subscriptions?.includes(content.userId) || false;
        }

        res.json({
            likeCount: content.likeCount || 0,
            dislikeCount: content.dislikeCount || 0,
            views: content.views || 0,
            userReaction,
            isSubscribed
        });
    } catch (error) {
        console.error('❌ Error fetching engagement status:', error);
        res.status(500).json({ error: 'Failed to fetch engagement status' });
    }
};

/**
 * POST /api/v2/content/:id/report
 * Report content (video, short, post, audio) — uses same ContentReport model as community feed.
 */
export const reportContent = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { id } = req.params;
        const { reason, description } = req.body;

        if (!id || !reason) {
            return res.status(400).json({ error: 'Content ID and reason are required' });
        }

        const validReasons = ['spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'copyright', 'off_topic', 'other'];
        if (!validReasons.includes(reason)) {
            return res.status(400).json({ error: 'Invalid reason' });
        }

        // Verify content exists
        const content = await Content.findById(id);
        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        // Check if user already reported this content
        const existing = await ContentReport.findOne({ contentId: id, reporterId: userId });
        if (existing) {
            return res.status(409).json({ error: 'You have already reported this content' });
        }

        await ContentReport.create({
            reporterId: userId,
            contentId: id,
            communityId: null,
            reason,
            description: description?.trim() || ''
        });

        return res.status(201).json({ message: 'Report submitted successfully' });
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ error: 'You have already reported this content' });
        console.error('reportContent error:', error);
        return res.status(500).json({ error: 'Failed to submit report' });
    }
};
