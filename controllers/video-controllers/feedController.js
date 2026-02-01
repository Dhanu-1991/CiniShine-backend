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
 * Returns shorts and audio separately for horizontal display rows
 * Uses WatchHistoryEngine for personalized recommendations when user is logged in
 */
export const getMixedFeed = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { page = 1, limit = 20, shortsLimit = 12, audioLimit = 8 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const isFirstPage = parseInt(page) === 1;

        console.log(`📥 [Feed] getMixedFeed called - userId: ${userId}, page: ${page}, limit: ${limit}`);

        // Fetch shorts (for horizontal row - only on first page)
        let shorts = [];
        if (isFirstPage || req.query.includeShorts === 'true') {
            console.log(`📥 [Feed] Fetching shorts...`);

            // Use WatchHistoryEngine for personalized shorts if user is logged in
            if (userId) {
                try {
                    const recommendations = await watchHistoryEngine.getRecommendations(
                        userId,
                        'short',
                        { limit: parseInt(shortsLimit) }
                    );
                    if (recommendations?.content?.length > 0) {
                        shorts = recommendations.content;
                        console.log(`✅ [Feed] Got ${shorts.length} personalized shorts from WatchHistoryEngine`);
                    }
                } catch (err) {
                    console.log(`ℹ️ [Feed] WatchHistoryEngine failed for shorts, falling back to default`);
                }
            }

            // Fallback to recent shorts if no personalized results
            if (shorts.length === 0) {
                const shortsQuery = {
                    contentType: 'short',
                    status: 'completed',
                    visibility: 'public'
                };

                shorts = await Content.find(shortsQuery)
                    .populate('userId', 'userName channelName channelPicture')
                    .sort({ createdAt: -1 })
                    .limit(parseInt(shortsLimit));
            }

            console.log(`✅ [Feed] Fetched ${shorts.length} shorts`);
        }

        // Fetch audio (for horizontal row - only on first page)
        let audioContent = [];
        if (isFirstPage || req.query.includeAudio === 'true') {
            console.log(`📥 [Feed] Fetching audio...`);

            // Use WatchHistoryEngine for personalized audio if user is logged in
            if (userId) {
                try {
                    const recommendations = await watchHistoryEngine.getRecommendations(
                        userId,
                        'audio',
                        { limit: parseInt(audioLimit) }
                    );
                    if (recommendations?.content?.length > 0) {
                        audioContent = recommendations.content;
                        console.log(`✅ [Feed] Got ${audioContent.length} personalized audio from WatchHistoryEngine`);
                    }
                } catch (err) {
                    console.log(`ℹ️ [Feed] WatchHistoryEngine failed for audio, falling back to default`);
                }
            }

            // Fallback to recent audio if no personalized results
            if (audioContent.length === 0) {
                const audioQuery = {
                    contentType: 'audio',
                    status: 'completed',
                    visibility: 'public'
                };

                audioContent = await Content.find(audioQuery)
                    .populate('userId', 'userName channelName channelPicture')
                    .sort({ createdAt: -1 })
                    .limit(parseInt(audioLimit));
            }

            console.log(`✅ [Feed] Fetched ${audioContent.length} audio tracks`);
        }

        // Fetch videos - use WatchHistoryEngine for personalized recommendations
        console.log(`📥 [Feed] Fetching videos...`);
        let videos = [];

        if (userId) {
            try {
                const recommendations = await watchHistoryEngine.getRecommendations(
                    userId,
                    'video',
                    { page: parseInt(page), limit: parseInt(limit) }
                );
                if (recommendations?.content?.length > 0) {
                    videos = recommendations.content;
                    console.log(`✅ [Feed] Got ${videos.length} personalized videos from WatchHistoryEngine`);
                }
            } catch (err) {
                console.log(`ℹ️ [Feed] WatchHistoryEngine failed for videos, falling back to default`);
            }
        }

        // Fallback to recent videos if no personalized results
        if (videos.length === 0) {
            videos = await Video.find({
                status: 'completed'
            })
                .populate('userId', 'userName channelName channelPicture')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit));
        }

        console.log(`✅ [Feed] Fetched ${videos.length} videos`);

        // Fetch posts
        console.log(`📥 [Feed] Fetching posts...`);
        const posts = await Content.find({
            contentType: 'post',
            status: 'completed',
            visibility: 'public'
        })
            .populate('userId', 'userName channelName channelPicture')
            .sort({ createdAt: -1 })
            .skip(isFirstPage ? 0 : skip)
            .limit(Math.floor(parseInt(limit) / 4));

        console.log(`✅ [Feed] Fetched ${posts.length} posts`);

        // Process shorts with URLs
        console.log(`🎬 [Feed] Processing ${shorts.length} shorts...`);
        const processedShorts = await Promise.all(
            shorts.map(async (content, idx) => {
                const thumbnailUrl = await generateSignedUrl(content.thumbnailKey);
                if (!thumbnailUrl) {
                    console.warn(`⚠️ [Feed] Short ${idx} (${content._id}): No thumbnail - thumbnailKey: ${content.thumbnailKey || 'MISSING'}`);
                }
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
                    status: content.status,
                    score: calculateScore(content)
                };
            })
        );
        console.log(`✅ [Feed] Processed ${processedShorts.length} shorts`);

        // Process audio with URLs - use thumbnailKey OR imageKey for album art
        console.log(`🎵 [Feed] Processing ${audioContent.length} audio tracks with thumbnail URLs...`);
        const processedAudio = await Promise.all(
            audioContent.map(async (content, idx) => {
                // For audio, thumbnailKey is the primary, imageKey is fallback
                const thumbnailKey = content.thumbnailKey || content.imageKey;
                const thumbnailUrl = await generateSignedUrl(thumbnailKey);
                if (!thumbnailUrl) {
                    console.warn(`⚠️ [Feed] Audio ${idx} (${content._id}): No thumbnail URL - thumbnailKey: ${content.thumbnailKey || 'MISSING'}, imageKey: ${content.imageKey || 'MISSING'}`);
                }
                return {
                    _id: content._id,
                    contentType: 'audio',
                    title: content.title,
                    description: content.description,
                    duration: content.duration,
                    thumbnailUrl,
                    imageUrl: content.imageKey ? await generateSignedUrl(content.imageKey) : null,
                    views: content.views,
                    likeCount: content.likeCount,
                    createdAt: content.createdAt,
                    channelName: content.userId?.channelName || content.userId?.userName || 'Unknown Channel',
                    channelPicture: content.userId?.channelPicture || null,
                    artist: content.artist,
                    album: content.album,
                    audioCategory: content.audioCategory,
                    status: content.status,
                    score: calculateScore(content)
                };
            })
        );
        console.log(`✅ [Feed] Processed ${processedAudio.length} audio tracks`);

        // Process videos with URLs
        console.log(`🎬 [Feed] Processing ${videos.length} videos with thumbnail URLs...`);
        const processedVideos = await Promise.all(
            videos.map(async (video, idx) => {
                const thumbnailUrl = await generateSignedUrl(video.thumbnailKey);
                if (!thumbnailUrl) {
                    console.warn(`⚠️ [Feed] Video ${idx} (${video._id}): No thumbnail URL - thumbnailKey: ${video.thumbnailKey || 'MISSING'}`);
                }
                return {
                    _id: video._id,
                    contentType: 'video',
                    title: video.title,
                    description: video.description,
                    duration: video.duration,
                    thumbnailUrl,
                    views: video.views,
                    likeCount: video.likes?.length || 0,
                    createdAt: video.createdAt,
                    channelName: video.channelName || video.userId?.channelName || video.userId?.userName || 'Unknown Channel',
                    channelPicture: video.userId?.channelPicture || null,
                    status: video.status,
                    score: calculateScore(video)
                };
            })
        );
        console.log(`✅ [Feed] Processed ${processedVideos.length} videos`);

        // Process posts with URLs - use imageKey for post images
        // Also fetch top comment for each post
        const processedPosts = await Promise.all(
            posts.map(async (content) => {
                // For posts, imageKey is the primary image
                const imageUrl = content.imageKey ? await generateSignedUrl(content.imageKey) : null;

                // Fetch top comment (most liked or most recent)
                let topComment = null;
                try {
                    const comment = await Comment.findOne({
                        videoId: content._id,
                        parentCommentId: null // Only top-level comments
                    })
                        .sort({ likeCount: -1, createdAt: -1 })
                        .populate('userId', 'userName channelName channelPicture')
                        .lean();

                    if (comment) {
                        topComment = {
                            _id: comment._id,
                            text: comment.text,
                            userName: comment.userId?.channelName || comment.userId?.userName || 'User',
                            userProfilePic: comment.userId?.channelPicture || null,
                            likeCount: comment.likeCount || 0
                        };
                    }
                } catch (err) {
                    console.error('Error fetching top comment for post:', err);
                }

                return {
                    _id: content._id,
                    contentType: 'post',
                    title: content.title,
                    description: content.description,
                    postContent: content.postContent,
                    thumbnailUrl: imageUrl, // Use image as thumbnail for consistency
                    imageUrl: imageUrl,
                    views: content.views,
                    likeCount: content.likeCount,
                    commentCount: content.commentCount || 0,
                    createdAt: content.createdAt,
                    channelName: content.userId?.channelName || content.userId?.userName || 'Unknown Channel',
                    channelPicture: content.userId?.channelPicture || null,
                    status: content.status,
                    score: calculateScore(content),
                    topComment: topComment
                };
            })
        );

        // Sort shorts by score
        processedShorts.sort((a, b) => b.score - a.score);
        processedAudio.sort((a, b) => b.score - a.score);
        processedVideos.sort((a, b) => b.score - a.score);
        processedPosts.sort((a, b) => b.score - a.score);

        // Return content SEPARATELY for proper frontend interleaving
        // Videos should NOT be mixed with audio/posts in main grid
        // Frontend will handle the interleaving algorithm

        // Get total counts for pagination
        const totalVideos = await Video.countDocuments({ status: 'completed' });
        const totalPosts = await Content.countDocuments({
            contentType: 'post',
            status: 'completed',
            visibility: 'public'
        });
        const totalAudio = await Content.countDocuments({
            contentType: 'audio',
            status: 'completed',
            visibility: 'public'
        });
        const total = totalVideos + totalPosts + totalAudio;

        res.json({
            shorts: isFirstPage ? processedShorts : [],
            videos: processedVideos,
            audio: isFirstPage ? processedAudio : [],
            posts: processedPosts,
            // Legacy: combined content for backward compatibility
            content: processedVideos,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                hasNextPage: skip + parseInt(limit) < total
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
