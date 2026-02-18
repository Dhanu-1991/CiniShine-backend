// controllers/content-controllers/feedController.js

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import Comment from '../../models/comment.model.js';
import { watchHistoryEngine } from '../../algorithms/watchHistoryRecommendation.js';
import { recommendationEngine } from '../../algorithms/recommendationAlgorithm.js';
import { getCfUrl } from '../../config/cloudfront.js';

/**
 * Generate CloudFront URL for S3 objects (replaces S3 signed URLs)
 */
const generateCfUrl = (key) => getCfUrl(key);


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
        const maxPages = 10;

        if (pageNum > maxPages) {
            return res.json({
                shorts: [],
                videos: [],
                audio: [],
                posts: [],
                sections: [],
                isFirstPage: false,
                pagination: {
                    currentPage: pageNum,
                    hasNextPage: false,
                    hasMoreShorts: false,
                    hasMoreAudio: false,
                    hasMoreVideos: false,
                    hasMorePosts: false,
                    totals: {
                        shorts: 0,
                        audio: 0,
                        videos: 0,
                        posts: 0
                    }
                }
            });
        }

        // Parse limits
        const shortsLimitNum = parseInt(shortsLimit);
        const audioLimitNum = parseInt(audioLimit);
        const videosLimitNum = parseInt(videosLimit);
        const postsLimitNum = parseInt(postsLimit);

        // Skip based on final content served per page for proper pagination
        const shortsSkip = (pageNum - 1) * shortsLimitNum;
        const audioSkip = (pageNum - 1) * audioLimitNum;
        const videosSkip = (pageNum - 1) * videosLimitNum;
        const postsSkip = (pageNum - 1) * postsLimitNum;

        console.log(`ðŸ“¥ [Feed] getMixedFeed called - userId: ${userId}, page: ${pageNum}`);
        console.log(`ðŸ“¥ [Feed] Skips: shorts=${shortsSkip}, audio=${audioSkip}, videos=${videosSkip}, posts=${postsSkip}`);

        // Get user's subscriptions for posts filtering
        let subscribedCreatorIds = [];
        let currentUser = null;
        if (userId) {
            currentUser = await User.findById(userId)
                .select('subscriptions roles prefferedRendition preferredTags')
                .lean();
            subscribedCreatorIds = currentUser?.subscriptions || [];
        }

        // OPTIMIZATION: Parallel fetch all content types at once
        // Sort by engagement metrics directly in DB query for efficiency
        const fetchPromises = [];

        // 1. Fetch shorts - sorted by views and recency
        fetchPromises.push(
            Content.find({
                contentType: 'short',
                status: 'completed',
                visibility: 'public'
            })
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .sort({ views: -1, likeCount: -1, createdAt: -1 })
                .skip(shortsSkip)
                .limit(shortsLimitNum)
                .lean()
        );

        // 2. Fetch audio - sorted by views and recency
        fetchPromises.push(
            Content.find({
                contentType: 'audio',
                status: 'completed',
                visibility: 'public'
            })
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .sort({ views: -1, likeCount: -1, createdAt: -1 })
                .skip(audioSkip)
                .limit(audioLimitNum)
                .lean()
        );

        // 3. Fetch videos - sorted by views and recency
        fetchPromises.push(
            Content.find({ status: 'completed', contentType: 'video' })
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .sort({ views: -1, createdAt: -1 })
                .skip(videosSkip)
                .limit(videosLimitNum)
                .lean()
        );

        // 4. Fetch posts ONLY from subscribed creators
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
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .sort({ views: -1, likeCount: -1, createdAt: -1 })
                .skip(postsSkip)
                .limit(postsLimitNum)
                .lean()
        );

        // 5. Get counts in parallel (for pagination)
        fetchPromises.push(Content.countDocuments({ contentType: 'short', status: 'completed', visibility: 'public' }));
        fetchPromises.push(Content.countDocuments({ contentType: 'audio', status: 'completed', visibility: 'public' }));
        fetchPromises.push(Content.countDocuments({ status: 'completed', contentType: 'video' }));

        // Count posts from subscribed creators only
        const postsCountQuery = subscribedCreatorIds.length > 0
            ? { contentType: 'post', status: 'completed', visibility: 'public', userId: { $in: subscribedCreatorIds } }
            : { contentType: 'post', status: 'completed', visibility: 'public' };
        fetchPromises.push(Content.countDocuments(postsCountQuery));

        // Wait for all fetches to complete
        const [shorts, audioContent, videos, posts, totalShorts, totalAudio, totalVideos, totalPosts] = await Promise.all(fetchPromises);

        console.log(`âœ… [Feed] Fetched: ${shorts.length} shorts, ${audioContent.length} audio, ${videos.length} videos, ${posts.length} posts`);
        console.log(`ðŸ“Š [Feed] Page ${pageNum} | Skips: shorts=${shortsSkip}, audio=${audioSkip}, videos=${videosSkip}, posts=${postsSkip}`);

        // Process content with signed URLs
        // Generate signed URLs for all content types in parallel
        const [processedShorts, processedAudio, processedVideos, processedPosts] = await Promise.all([
            // Process shorts
            Promise.all(shorts.map(async (content) => ({
                _id: content._id,
                contentType: 'short',
                title: content.title,
                description: content.description,
                duration: content.duration,
                thumbnailUrl: generateCfUrl(content.thumbnailKey),
                views: content.views,
                likeCount: content.likeCount,
                createdAt: content.createdAt,
                channelName: content.userId?.channelName || content.userId?.userName || 'Unknown Channel',
                channelPicture: generateCfUrl(content.userId?.channelPicture) || null,
                userId: content.userId?._id,
                status: content.status
            }))),

            // Process audio
            Promise.all(audioContent.map(async (content) => ({
                _id: content._id,
                contentType: 'audio',
                title: content.title,
                description: content.description,
                duration: content.duration,
                thumbnailUrl: generateCfUrl(content.thumbnailKey || content.imageKey),
                imageUrl: content.imageKey ? generateCfUrl(content.imageKey) : null,
                views: content.views,
                likeCount: content.likeCount,
                createdAt: content.createdAt,
                channelName: content.userId?.channelName || content.userId?.userName || 'Unknown Channel',
                channelHandle: content.userId?.channelHandle || null,
                channelPicture: generateCfUrl(content.userId?.channelPicture) || null,
                userId: content.userId?._id,
                artist: content.artist,
                album: content.album,
                audioCategory: content.audioCategory,
                status: content.status
            }))),

            // Process videos
            Promise.all(videos.map(async (video) => ({
                _id: video._id,
                contentType: 'video',
                title: video.title,
                description: video.description,
                duration: video.duration,
                thumbnailUrl: generateCfUrl(video.thumbnailKey),
                views: video.views,
                likeCount: video.likes?.length || 0,
                createdAt: video.createdAt,
                channelName: video.channelName || video.userId?.channelName || video.userId?.userName || 'Unknown Channel',
                channelHandle: video.userId?.channelHandle || null,
                channelPicture: generateCfUrl(video.userId?.channelPicture) || null,
                userId: video.userId?._id,
                status: video.status
            }))),

            // Process posts
            Promise.all(posts.map(async (content) => ({
                _id: content._id,
                contentType: 'post',
                title: content.title,
                description: content.description,
                postContent: content.postContent,
                thumbnailUrl: content.imageKey ? generateCfUrl(content.imageKey) : null,
                imageUrl: content.imageKey ? generateCfUrl(content.imageKey) : null,
                views: content.views,
                likeCount: content.likeCount,
                createdAt: content.createdAt,
                channelName: content.userId?.channelName || content.userId?.userName || 'Unknown Channel',
                channelHandle: content.userId?.channelHandle || null,
                channelPicture: generateCfUrl(content.userId?.channelPicture) || null,
                userId: content.userId?._id,
                status: content.status
            })))
        ]);

        // Content is already limited by DB query, no slicing needed
        // Split videos into 4 rows of 3 for layout: row2-3 (6) and row5-6 (6)
        const videosBatch1 = processedVideos.slice(0, 3); // Row 2
        const videosBatch2 = processedVideos.slice(3, 6); // Row 3
        const videosBatch3 = processedVideos.slice(6, 9); // Row 5
        const videosBatch4 = processedVideos.slice(9, 12); // Row 6

        const sections = [];

        if (isFirstPage) {
            // Fixed order for first page:
            // Row 1: 5 shorts
            // Row 2-3: 6 videos (3+3)
            // Row 4: 5 audio
            // Row 5-6: 6 videos (3+3)
            // Row 7: 1 post
            if (processedShorts.length > 0) {
                sections.push({ type: 'shorts', data: processedShorts, key: `shorts-${pageNum}` });
            }
            if (videosBatch1.length > 0) {
                sections.push({ type: 'videos', data: videosBatch1, key: `videos-1-${pageNum}` });
            }
            if (videosBatch2.length > 0) {
                sections.push({ type: 'videos', data: videosBatch2, key: `videos-2-${pageNum}` });
            }
            if (processedAudio.length > 0) {
                sections.push({ type: 'audio', data: processedAudio, key: `audio-${pageNum}` });
            }
            if (videosBatch3.length > 0) {
                sections.push({ type: 'videos', data: videosBatch3, key: `videos-3-${pageNum}` });
            }
            if (videosBatch4.length > 0) {
                sections.push({ type: 'videos', data: videosBatch4, key: `videos-4-${pageNum}` });
            }
            if (processedPosts.length > 0) {
                sections.push({ type: 'post-single', data: processedPosts[0], key: `post-${pageNum}` });
            }
        } else {
            // Randomized order for subsequent pages
            const availableSections = [];

            if (processedShorts.length > 0) {
                availableSections.push({ type: 'shorts', data: processedShorts, key: `shorts-${pageNum}` });
            }
            // Combine video batches for randomization
            const allVideos = [...videosBatch1, ...videosBatch2, ...videosBatch3, ...videosBatch4];
            if (allVideos.length > 0) {
                // Split into chunks of 3 for display
                for (let i = 0; i < allVideos.length; i += 3) {
                    const chunk = allVideos.slice(i, i + 3);
                    if (chunk.length > 0) {
                        availableSections.push({
                            type: 'videos',
                            data: chunk,
                            key: `videos-${Math.floor(i / 3) + 1}-${pageNum}`
                        });
                    }
                }
            }
            if (processedAudio.length > 0) {
                availableSections.push({ type: 'audio', data: processedAudio, key: `audio-${pageNum}` });
            }
            if (processedPosts.length > 0) {
                availableSections.push({ type: 'post-single', data: processedPosts[0], key: `post-${pageNum}` });
            }

            // Shuffle sections for randomized order
            for (let i = availableSections.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [availableSections[i], availableSections[j]] = [availableSections[j], availableSections[i]];
            }

            sections.push(...availableSections);
        }

        // Calculate if there's more content available
        const hasMoreShorts = (shortsSkip + processedShorts.length) < totalShorts;
        const hasMoreAudio = (audioSkip + processedAudio.length) < totalAudio;
        const hasMoreVideos = (videosSkip + processedVideos.length) < totalVideos;
        const hasMorePosts = (postsSkip + processedPosts.length) < totalPosts;

        console.log(`ðŸ“Š [Feed] Page ${pageNum} - served: shorts=${processedShorts.length}, audio=${processedAudio.length}, videos=${processedVideos.length}, posts=${processedPosts.length}`);
        console.log(`ðŸ“Š [Feed] Totals - shorts: ${totalShorts}, audio: ${totalAudio}, videos: ${totalVideos}, posts: ${totalPosts}`);
        console.log(`ðŸ“Š [Feed] hasMore - shorts: ${hasMoreShorts}, audio: ${hasMoreAudio}, videos: ${hasMoreVideos}, posts: ${hasMorePosts}`);

        // Continue pagination if ANY content type has more and within max page limit
        const hasNextPage = pageNum < maxPages && (hasMoreShorts || hasMoreAudio || hasMoreVideos || hasMorePosts);

        res.json({
            shorts: processedShorts,
            videos: processedVideos,
            audio: processedAudio,
            posts: processedPosts,
            sections,
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
        console.error('âŒ Error fetching mixed feed:', error);
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
        const currentVideo = await Content.findById(videoId);
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
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .sort({ views: -1, createdAt: -1 })
                .limit(parseInt(shortsLimit));

            console.log(`ðŸ“¥ [Recommendations] Fetched ${shorts.length} shorts for first page`);
            shorts.forEach((short, idx) => {
                console.log(`  Short ${idx}: ${short._id}, thumbnailKey: ${short.thumbnailKey}, title: ${short.title}`);
            });
        }

        // Fetch similar videos
        const allVideos = await Content.find({
            status: 'completed',
            contentType: 'video',
            _id: { $ne: videoId }
        }).populate('userId', 'userName channelName channelHandle channelPicture');

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
                const thumbnailUrl = generateCfUrl(content.thumbnailKey);
                console.log(`âœ… [Recommendations] Processing short ${idx}: ${content._id}, URL: ${thumbnailUrl ? 'generated' : 'null'}`);
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
                    channelHandle: content.userId?.channelHandle || null,
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
                thumbnailUrl: generateCfUrl(video.thumbnailKey),
                views: video.views,
                likeCount: video.likes?.length || 0,
                createdAt: video.createdAt,
                channelName: video.channelName || video.userId?.channelName || video.userId?.userName || 'Unknown Channel',
                channelHandle: video.userId?.channelHandle || null,
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
        console.error('âŒ Error fetching recommendations with shorts:', error);
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
