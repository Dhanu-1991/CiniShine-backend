// controllers/video-controllers/feedController.js

import mongoose from 'mongoose';
import Video from '../../models/video.model.js';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import Comment from '../../models/comment.model.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { watchHistoryEngine } from '../../algorithms/watchHistoryRecommendation.js';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Generate signed URL for S3 objects
 */
const generateSignedUrl = async (key) => {
    if (!key) {
        console.warn(`⚠️ [S3] No key provided for signed URL generation`);
        return null;
    }
    try {
        const url = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: key,
            }),
            { expiresIn: 3600 }
        );
        console.log(`✅ [S3] Generated signed URL for key: ${key.substring(0, 50)}...`);
        return url;
    } catch (error) {
        console.error(`❌ [S3] Error generating signed URL for key ${key}:`, error.message);
        return null;
    }
};

/**
 * Calculate recommendation score for content
 */
const calculateScore = (item, userPreferences = {}) => {
    let score = 0;

    // Popularity score (30%)
    const maxViews = 10000;
    score += Math.min((item.views || 0) / maxViews, 1) * 0.3;

    // Recency score (25%)
    const daysSinceCreation = (new Date() - new Date(item.createdAt)) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 1 - daysSinceCreation / 30) * 0.25;

    // Engagement score (25%)
    const likes = item.likeCount || item.likes || 0;
    const comments = item.commentCount || 0;
    const engagement = (likes + comments * 2) / Math.max(item.views || 1, 1);
    score += Math.min(engagement * 10, 1) * 0.25;

    // Random factor for diversity (20%)
    score += Math.random() * 0.2;

    return score;
};

/**
 * Get mixed feed content (videos, shorts, audio, posts)
 * Returns content according to dashboard layout requirements:
 * - 5 shorts, 5 audio, 12 videos, 1 post per fetch
 * - Posts only from subscribed creators
 * - First fetch: fixed order, subsequent fetches: randomized
 */
export const getMixedFeed = async (req, res) => {
    try {
        const userId = req.user?.id;
        const {
            page = 1,
            shortsLimit = 5,
            audioLimit = 5,
            videosLimit = 12,
            postsLimit = 1
        } = req.query;

        const pageNum = parseInt(page);
        const isFirstPage = pageNum === 1;

        // Calculate skip for each content type based on page
        const shortsSkip = (pageNum - 1) * parseInt(shortsLimit);
        const audioSkip = (pageNum - 1) * parseInt(audioLimit);
        const videosSkip = (pageNum - 1) * parseInt(videosLimit);
        const postsSkip = (pageNum - 1) * parseInt(postsLimit);

        console.log(`📥 [Feed] getMixedFeed called - userId: ${userId}, page: ${page}`);

        // Get user's subscriptions for posts filtering
        let subscribedCreatorIds = [];
        if (userId) {
            const user = await User.findById(userId).select('subscriptions').lean();
            subscribedCreatorIds = user?.subscriptions || [];
        }

        // OPTIMIZATION: Parallel fetch all content types at once
        const fetchPromises = [];

        // 1. Fetch shorts (5 per page)
        fetchPromises.push(
            Content.find({
                contentType: 'short',
                status: 'completed',
                visibility: 'public'
            })
                .populate('userId', 'userName channelName channelPicture')
                .sort({ createdAt: -1 })
                .skip(shortsSkip)
                .limit(parseInt(shortsLimit))
                .lean()
        );

        // 2. Fetch audio (5 per page)
        fetchPromises.push(
            Content.find({
                contentType: 'audio',
                status: 'completed',
                visibility: 'public'
            })
                .populate('userId', 'userName channelName channelPicture')
                .sort({ createdAt: -1 })
                .skip(audioSkip)
                .limit(parseInt(audioLimit))
                .lean()
        );

        // 3. Fetch videos (12 per page)
        fetchPromises.push(
            Video.find({ status: 'completed' })
                .populate('userId', 'userName channelName channelPicture')
                .sort({ createdAt: -1 })
                .skip(videosSkip)
                .limit(parseInt(videosLimit))
                .lean()
        );

        // 4. Fetch posts ONLY from subscribed creators (1 per page)
        const postsQuery = {
            contentType: 'post',
            status: 'completed',
            visibility: 'public'
        };

        // Only filter by subscriptions if user has subscriptions
        if (subscribedCreatorIds.length > 0) {
            postsQuery.userId = { $in: subscribedCreatorIds };
        }

        fetchPromises.push(
            Content.find(postsQuery)
                .populate('userId', 'userName channelName channelPicture')
                .sort({ createdAt: -1 })
                .skip(postsSkip)
                .limit(parseInt(postsLimit))
                .lean()
        );

        // 5. Get counts in parallel (for pagination)
        fetchPromises.push(Content.countDocuments({ contentType: 'short', status: 'completed', visibility: 'public' }));
        fetchPromises.push(Content.countDocuments({ contentType: 'audio', status: 'completed', visibility: 'public' }));
        fetchPromises.push(Video.countDocuments({ status: 'completed' }));

        // Count posts from subscribed creators only
        const postsCountQuery = subscribedCreatorIds.length > 0
            ? { contentType: 'post', status: 'completed', visibility: 'public', userId: { $in: subscribedCreatorIds } }
            : { contentType: 'post', status: 'completed', visibility: 'public' };
        fetchPromises.push(Content.countDocuments(postsCountQuery));

        // Wait for all fetches to complete
        const [shorts, audioContent, videos, posts, totalShorts, totalAudio, totalVideos, totalPosts] = await Promise.all(fetchPromises);

        console.log(`✅ [Feed] Fetched: ${shorts.length} shorts, ${audioContent.length} audio, ${videos.length} videos, ${posts.length} posts`);

        // OPTIMIZATION: Batch generate signed URLs with Promise.all
        // Process all content types in parallel
        const [processedShorts, processedAudio, processedVideos, processedPosts] = await Promise.all([
            // Process shorts
            Promise.all(shorts.map(async (content) => ({
                _id: content._id,
                contentType: 'short',
                title: content.title,
                description: content.description,
                duration: content.duration,
                thumbnailUrl: await generateSignedUrl(content.thumbnailKey),
                views: content.views,
                likeCount: content.likeCount,
                createdAt: content.createdAt,
                channelName: content.userId?.channelName || content.userId?.userName || 'Unknown Channel',
                channelPicture: content.userId?.channelPicture || null,
                userId: content.userId?._id,
                status: content.status,
                score: calculateScore(content)
            }))),

            // Process audio
            Promise.all(audioContent.map(async (content) => ({
                _id: content._id,
                contentType: 'audio',
                title: content.title,
                description: content.description,
                duration: content.duration,
                thumbnailUrl: await generateSignedUrl(content.thumbnailKey || content.imageKey),
                imageUrl: content.imageKey ? await generateSignedUrl(content.imageKey) : null,
                views: content.views,
                likeCount: content.likeCount,
                createdAt: content.createdAt,
                channelName: content.userId?.channelName || content.userId?.userName || 'Unknown Channel',
                channelPicture: content.userId?.channelPicture || null,
                userId: content.userId?._id,
                artist: content.artist,
                album: content.album,
                audioCategory: content.audioCategory,
                status: content.status,
                score: calculateScore(content)
            }))),

            // Process videos
            Promise.all(videos.map(async (video) => ({
                _id: video._id,
                contentType: 'video',
                title: video.title,
                description: video.description,
                duration: video.duration,
                thumbnailUrl: await generateSignedUrl(video.thumbnailKey),
                views: video.views,
                likeCount: video.likes?.length || 0,
                createdAt: video.createdAt,
                channelName: video.channelName || video.userId?.channelName || video.userId?.userName || 'Unknown Channel',
                channelPicture: video.userId?.channelPicture || null,
                userId: video.userId?._id,
                status: video.status,
                score: calculateScore(video)
            }))),

            // Process posts
            Promise.all(posts.map(async (content) => ({
                _id: content._id,
                contentType: 'post',
                title: content.title,
                description: content.description,
                postContent: content.postContent,
                thumbnailUrl: content.imageKey ? await generateSignedUrl(content.imageKey) : null,
                imageUrl: content.imageKey ? await generateSignedUrl(content.imageKey) : null,
                views: content.views,
                likeCount: content.likeCount,
                commentCount: content.commentCount || 0,
                createdAt: content.createdAt,
                channelName: content.userId?.channelName || content.userId?.userName || 'Unknown Channel',
                channelPicture: content.userId?.channelPicture || null,
                userId: content.userId?._id,
                status: content.status,
                score: calculateScore(content)
            })))
        ]);

        // Sort by score for better recommendations
        processedShorts.sort((a, b) => b.score - a.score);
        processedAudio.sort((a, b) => b.score - a.score);
        processedVideos.sort((a, b) => b.score - a.score);
        processedPosts.sort((a, b) => b.score - a.score);

        // Calculate if there's more content available
        const hasMoreShorts = shortsSkip + shorts.length < totalShorts;
        const hasMoreAudio = audioSkip + audioContent.length < totalAudio;
        const hasMoreVideos = videosSkip + videos.length < totalVideos;
        const hasMorePosts = postsSkip + posts.length < totalPosts;

        // Continue pagination if ANY content type has more
        const hasNextPage = hasMoreShorts || hasMoreAudio || hasMoreVideos || hasMorePosts;

        res.json({
            shorts: processedShorts,
            videos: processedVideos,
            audio: processedAudio,
            posts: processedPosts,
            isFirstPage,
            pagination: {
                currentPage: pageNum,
                hasNextPage,
                hasMoreShorts,
                hasMoreAudio,
                hasMoreVideos,
                hasMorePosts,
                totals: {
                    shorts: totalShorts,
                    audio: totalAudio,
                    videos: totalVideos,
                    posts: totalPosts
                }
            }
        });

    } catch (error) {
        console.error('❌ Error fetching mixed feed:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get recommendations with shorts prioritized
 * Used in WatchPage sidebar
 */
export const getRecommendationsWithShorts = async (req, res) => {
    try {
        const { videoId } = req.params;
        const { page = 1, limit = 10, shortsLimit = 4 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const isFirstPage = parseInt(page) === 1;

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        // Get current video for similarity calculation
        const currentVideo = await Video.findById(videoId);
        if (!currentVideo) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Extract keywords from current video
        const keywords = extractKeywords(currentVideo);

        // Fetch shorts for first row (only on first page)
        let shorts = [];
        if (isFirstPage) {
            shorts = await Content.find({
                contentType: 'short',
                status: 'completed',
                visibility: 'public'
            })
                .populate('userId', 'userName channelName channelPicture')
                .sort({ views: -1, createdAt: -1 })
                .limit(parseInt(shortsLimit));

            console.log(`📥 [Recommendations] Fetched ${shorts.length} shorts for first page`);
            shorts.forEach((short, idx) => {
                console.log(`  Short ${idx}: ${short._id}, thumbnailKey: ${short.thumbnailKey}, title: ${short.title}`);
            });
        }

        // Fetch similar videos
        const allVideos = await Video.find({
            status: 'completed',
            _id: { $ne: videoId }
        }).populate('userId', 'userName channelName channelPicture');

        // Calculate similarity scores
        const scoredVideos = allVideos.map(video => ({
            ...video.toObject(),
            similarityScore: calculateSimilarityScore(currentVideo, video, keywords)
        }));

        // Sort by similarity score descending
        scoredVideos.sort((a, b) => b.similarityScore - a.similarityScore);

        // Apply pagination
        const paginatedVideos = scoredVideos.slice(skip, skip + parseInt(limit));

        // Process shorts with URLs
        const processedShorts = await Promise.all(
            shorts.map(async (content, idx) => {
                const thumbnailUrl = await generateSignedUrl(content.thumbnailKey);
                console.log(`✅ [Recommendations] Processing short ${idx}: ${content._id}, URL: ${thumbnailUrl ? 'generated' : 'null'}`);
                return {
                    _id: content._id,
                    contentType: 'short',
                    title: content.title,
                    description: content.description,
                    duration: content.duration,
                    thumbnailUrl,
                    views: content.views,
                    likeCount: content.likeCount,
                    createdAt: content.createdAt,
                    channelName: content.userId?.channelName || content.userId?.userName || 'Unknown Channel',
                    channelPicture: content.userId?.channelPicture || null,
                    status: content.status
                };
            })
        );

        // Process videos with URLs
        const processedVideos = await Promise.all(
            paginatedVideos.map(async (video) => ({
                _id: video._id,
                contentType: 'video',
                title: video.title,
                description: video.description,
                duration: video.duration,
                thumbnailUrl: await generateSignedUrl(video.thumbnailKey),
                views: video.views,
                likeCount: video.likes?.length || 0,
                createdAt: video.createdAt,
                channelName: video.channelName || video.userId?.channelName || video.userId?.userName || 'Unknown Channel',
                channelPicture: video.userId?.channelPicture || null,
                status: video.status,
                similarityScore: video.similarityScore
            }))
        );

        const totalVideos = scoredVideos.length;
        const hasNextPage = skip + parseInt(limit) < totalVideos;

        res.json({
            shorts: processedShorts,
            videos: processedVideos,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalVideos / parseInt(limit)),
                totalVideos,
                hasNextPage,
                limit: parseInt(limit)
            }
        });

    } catch (error) {
        console.error('❌ Error fetching recommendations with shorts:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Extract keywords from video title and description
 */
const extractKeywords = (video) => {
    const text = `${video.title} ${video.description || ''}`.toLowerCase();
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those'];

    const words = text
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.includes(word));

    return [...new Set(words)];
};

/**
 * Calculate similarity score between two videos
 */
const calculateSimilarityScore = (video1, video2, keywords1) => {
    let score = 0;

    // Keyword overlap (40%)
    const keywords2 = extractKeywords(video2);
    const commonKeywords = keywords1.filter(keyword => keywords2.includes(keyword));
    const keywordSimilarity = keywords1.length > 0 ? commonKeywords.length / Math.max(keywords1.length, keywords2.length) : 0;
    score += keywordSimilarity * 0.4;

    // Same creator boost (20%)
    const userSimilarity = video1.userId?.toString() === video2.userId?.toString() ? 1 : 0;
    score += userSimilarity * 0.2;

    // Popularity (20%)
    const maxViews = 10000;
    score += Math.min((video2.views || 0) / maxViews, 1) * 0.2;

    // Recency (10%)
    const daysSinceCreation = (new Date() - new Date(video2.createdAt)) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 1 - daysSinceCreation / 365) * 0.1;

    // Duration similarity (10%)
    if (video1.duration && video2.duration) {
        const durationDiff = Math.abs(video1.duration - video2.duration);
        const durationSimilarity = Math.max(0, 1 - durationDiff / Math.max(video1.duration, video2.duration));
        score += durationSimilarity * 0.1;
    }

    return Math.min(score, 1);
};
