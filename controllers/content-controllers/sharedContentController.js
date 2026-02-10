/**
 * Shared Content Controller
 * Handles: get content, upload thumbnail, feed content, single content
 * Shared functions used by all content types
 *
 * ═══════════════════════════════════════════════════════════
 * HOW VIEWS ARE COUNTED (for SHORTS, AUDIO, POSTS):
 * ═══════════════════════════════════════════════════════════
 * 1. Frontend players (ShortsPlayer, AudioPlayer, PostViewPage) send watch time
 *    to POST /api/v2/content/:id/watch-time every 10s while playing.
 * 2. Backend receives watchTime in ms, converts to seconds.
 * 3. Rate-limited: 30s cooldown per user+content (in-memory Map).
 * 4. View counting thresholds (minimum watch before counting a view):
 *    - Shorts: 2s
 *    - Audio:  5s
 *    - Posts:  3s
 *    - Video:  10s (fallback)
 * 5. View cooldowns (prevent re-counting from same user):
 *    - Shorts: 1 minute between views
 *    - Others: 5 minutes between views
 *    - Checked via WatchHistory.lastWatchedAt (NOT user.viewHistory[])
 * 6. totalWatchTime always accumulates on every valid request.
 * 7. views only increments when BOTH threshold met AND cooldown passed.
 * 8. averageWatchTime = totalWatchTime / views (recalculated on EVERY update).
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
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const s3ExistenceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function s3ObjectExists(bucket, key) {
    const cacheKey = `${bucket}:${key}`;
    const cached = s3ExistenceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.exists;
    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        s3ExistenceCache.set(cacheKey, { exists: true, timestamp: Date.now() });
        return true;
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            s3ExistenceCache.set(cacheKey, { exists: false, timestamp: Date.now() });
            return false;
        }
        return true;
    }
}

async function getSignedUrlIfExists(bucket, key, expiresIn = 3600) {
    if (!key) return null;
    if (!(await s3ObjectExists(bucket, key))) return null;
    try {
        return await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
    } catch (err) {
        console.error(`Error generating signed URL for ${key}:`, err.message);
        return null;
    }
}

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

        const content = await Content.findById(contentId).populate('userId', 'userName channelName channelPicture profilePicture');
        if (!content) return res.status(404).json({ error: 'Content not found' });

        const thumbnailUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey);
        const imageUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.imageKey);
        let audioUrl = null;
        if (content.contentType === 'audio' && content.originalKey) {
            audioUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.originalKey);
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
            thumbnailUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey),
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
            .populate('userId', 'userName channelName channelPicture')
            .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
        const total = await Content.countDocuments(query);

        const contentsWithUrls = await Promise.all(contents.map(async (content) => {
            const commentCount = await Comment.countDocuments({ videoId: content._id, onModel: 'Content', parentCommentId: null });
            return {
                _id: content._id, contentType: content.contentType, title: content.title,
                description: content.description, postContent: content.postContent,
                duration: content.duration,
                thumbnailUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey),
                imageUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, content.imageKey),
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

        const content = await Content.findById(id).populate('userId', 'userName channelName channelPicture');
        if (!content) return res.status(404).json({ error: 'Content not found' });

        const commentCount = await Comment.countDocuments({ videoId: content._id, onModel: 'Content', parentCommentId: null });
        const thumbnailUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.thumbnailKey);
        const imageUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, content.imageKey);

        let imageUrls = [];
        if (content.contentType === 'post' && content.imageKeys?.length > 0) {
            imageUrls = (await Promise.all(content.imageKeys.map(key => getSignedUrlIfExists(process.env.S3_BUCKET, key)))).filter(Boolean);
        } else if (imageUrl) {
            imageUrls = [imageUrl];
        }

        let mediaUrl = null;
        if (content.contentType === 'short') {
            const videoKey = content.hlsKey || content.processedKey || content.originalKey;
            mediaUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, videoKey);
        } else if (content.contentType === 'audio') {
            const audioKey = content.processedKey || content.originalKey;
            mediaUrl = await getSignedUrlIfExists(process.env.S3_BUCKET, audioKey);
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

// In-memory rate limiter: userId:contentId → last update timestamp
const watchTimeRateLimit = new Map();
const RATE_LIMIT_WINDOW = 30 * 1000; // 30s between updates per user+content

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
        if (!watchTime || typeof watchTime !== 'number' || watchTime <= 0)
            return res.status(400).json({ error: 'Invalid watch time' });

        // Rate limit: 30s between calls for the same user+content
        const rateKey = `${userId}:${id}`;
        const lastUpdate = watchTimeRateLimit.get(rateKey);
        if (lastUpdate && Date.now() - lastUpdate < RATE_LIMIT_WINDOW) {
            console.log(`⏸️ [WatchTime] Rate limited - ${rateKey}`);
            return res.json({ message: 'Rate limited, skipped', rateLimited: true });
        }
        watchTimeRateLimit.set(rateKey, Date.now());

        const content = await Content.findById(id);
        if (!content) return res.status(404).json({ error: 'Content not found' });

        // FIX: If content has no duration and client sent one, update it.
        // This fixes shorts/audio that were uploaded before duration tracking was added.
        if ((!content.duration || content.duration === 0) && clientDuration && clientDuration > 0) {
            content.duration = clientDuration;
            console.log(`📏 [Duration] Fixed missing duration for ${content.contentType} "${content.title}": ${clientDuration}s`);
        }

        const watchTimeSeconds = watchTime / 1000;
        console.log(`📊 [WatchTime] ${content.contentType} "${content.title}" - ${watchTimeSeconds}s sent, current views: ${content.views}, totalWatchTime: ${content.totalWatchTime || 0}s`);

        // Minimum watch threshold before counting a view:
        // Shorts (<60s): 2s | Audio: 5s | Posts: 3s (just opened) | Videos: 10s
        const viewThresholds = { short: 2, audio: 5, post: 3, video: 10 };
        const threshold = viewThresholds[content.contentType] || 5;

        // Always accumulate total watch time
        content.totalWatchTime = (content.totalWatchTime || 0) + watchTimeSeconds;

        // Only increment views if threshold met AND user hasn't viewed recently
        let viewCounted = false;
        const existingHistory = await WatchHistory.findOne({ userId, contentId: id });
        const viewCooldown = content.contentType === 'short' ? 60000 : 300000; // 1min for shorts, 5min otherwise

        if (watchTimeSeconds >= threshold) {
            const canCountView = !existingHistory ||
                (Date.now() - new Date(existingHistory.lastWatchedAt).getTime() > viewCooldown);
            if (canCountView) {
                content.views = (content.views || 0) + 1;
                viewCounted = true;
            }
        }

        content.averageWatchTime = content.views > 0
            ? content.totalWatchTime / content.views : 0;
        await content.save();

        console.log(`✅ [WatchTime] Saved - views: ${content.views}, avgWatchTime: ${content.averageWatchTime.toFixed(1)}s, viewCounted: ${viewCounted}, totalWatchTime: ${content.totalWatchTime.toFixed(1)}s`);

        // Check if user has history tracking paused
        const user = await (await import('../../models/user.model.js')).default.findById(userId, 'historyPaused');
        const historyPaused = user?.historyPaused || false;

        if (!historyPaused) {
            // Upsert WatchHistory for the recommendation engine
            const watchPercentage = content.duration > 0
                ? Math.min(100, (watchTimeSeconds / content.duration) * 100) : 0;
            const completedWatch = watchPercentage >= 80;

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
                        watchCount: viewCounted ? 1 : 0
                    },
                    $setOnInsert: {
                        firstWatchedAt: new Date()
                    },
                    $push: {
                        sessions: {
                            $each: [{
                                startedAt: new Date(Date.now() - watchTime),
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
