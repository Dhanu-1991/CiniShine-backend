// controllers/content-controllers/feedController.js

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import Comment from '../../models/comment.model.js';
import WatchHistory from '../../models/watchHistory.model.js';
import { watchHistoryEngine } from '../../algorithms/watchHistoryRecommendation.js';
import { recommendationEngine } from '../../algorithms/recommendationAlgorithm.js';
import { findSimilarVideos } from '../../algorithms/videoSimilarity.js';
import { getCfUrl, getCfHlsMasterUrl } from '../../config/cloudfront.js';

/**
 * Generate CloudFront URL for S3 objects (replaces S3 signed URLs)
 */
const generateCfUrl = (key) => getCfUrl(key);

const normalizeFeedItem = (c) => {
    const contentType = c.contentType || 'video';
    let videoUrl = null;
    let hlsMasterUrl = null;
    let audioUrl = null;

    if (contentType === 'video' || contentType === 'short') {
        hlsMasterUrl = c.hlsMasterKey ? getCfHlsMasterUrl(c.hlsMasterKey) : null;
        const videoKey = c.hlsMasterKey || c.processedKey || c.originalKey;
        if (videoKey) videoUrl = getCfUrl(videoKey);
    } else if (contentType === 'audio') {
        const audioKey = c.processedKey || c.originalKey;
        if (audioKey) audioUrl = getCfUrl(audioKey);
    }

    return {
        _id: c._id,
        contentType,
        title: c.title,
        description: c.description,
        duration: c.duration,
        thumbnailUrl: getCfUrl(c.thumbnailKey),
        imageUrl: c.imageKey ? getCfUrl(c.imageKey) : null,
        hlsMasterUrl,
        videoUrl,
        audioUrl,
        views: c.views,
        likeCount: c.likeCount || c.likes?.length || 0,
        createdAt: c.createdAt,
        channelName: c.channelName || c.userId?.channelName || c.userId?.userName || 'Unknown',
        channelPicture: c.userId?.channelPicture || null,
        channelHandle: c.userId?.channelHandle || null,
        userId: c.userId?._id || c.userId,
        status: c.status,
        tags: c.tags,
        category: c.category,
        artist: c.artist,
        album: c.album,
        audioCategory: c.audioCategory,
        postContent: c.postContent,
    };
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
            postsLimit = 1,
            seenIds = ''
        } = req.query;

        const pageNum = parseInt(page);
        const isFirstPage = pageNum === 1;
        const maxPages = 10;

        if (pageNum > maxPages) {
            return res.json({
                shorts: [], videos: [], audio: [], posts: [], sections: [],
                isFirstPage: false,
                pagination: {
                    currentPage: pageNum, hasNextPage: false,
                    hasMoreShorts: false, hasMoreAudio: false,
                    hasMoreVideos: false, hasMorePosts: false,
                    totals: { shorts: 0, audio: 0, videos: 0, posts: 0 }
                }
            });
        }

        const shortsLimitNum = parseInt(shortsLimit);
        const audioLimitNum = parseInt(audioLimit);
        const videosLimitNum = parseInt(videosLimit);
        const postsLimitNum = parseInt(postsLimit);

        // IDs the client already has — excludes them so backend won't return duplicates
        const excludeIds = seenIds ? seenIds.split(',').filter(Boolean) : [];

        // ── Algorithm-driven parallel fetch ───────────────────────────────
        // watchHistoryEngine scores by full watch-history profile for auth users.
        // For guests it applies recency + popularity + engagement + jitter fallback.
        // This completely replaces the old views-only database sort.
        const [shortsResult, videosResult, audioResult, postsResult] = await Promise.all([
            watchHistoryEngine.getRecommendations(userId, 'short', {
                page: 1, limit: shortsLimitNum, excludeIds
            }),
            watchHistoryEngine.getRecommendations(userId, 'video', {
                page: pageNum, limit: videosLimitNum, excludeIds
            }),
            watchHistoryEngine.getRecommendations(userId, 'audio', {
                page: 1, limit: audioLimitNum, excludeIds
            }),
            watchHistoryEngine.getRecommendations(userId, 'post', {
                page: 1, limit: postsLimitNum, excludeIds
            }),
        ]);

        // Engine already generates CloudFront URLs and normalises all fields
        const processedShorts = shortsResult.content || [];
        const processedVideos = videosResult.content || [];
        const processedAudio = audioResult.content || [];
        const processedPosts = postsResult.content || [];

        const videosPagination = videosResult.pagination || {};
        const totalVideos = videosPagination.totalItems || processedVideos.length;

        // ── Section layout — algorithm-driven order for all pages ──────────
        const videosBatch1 = processedVideos.slice(0, 3);
        const videosBatch2 = processedVideos.slice(3, 6);
        const videosBatch3 = processedVideos.slice(6, 9);
        const videosBatch4 = processedVideos.slice(9, 12);

        const sections = [];

        const available = [];
        if (processedShorts.length > 0) available.push({ type: 'shorts', data: processedShorts, key: `shorts-${pageNum}` });
        const allVids = [...videosBatch1, ...videosBatch2, ...videosBatch3, ...videosBatch4];
        for (let i = 0; i < allVids.length; i += 3) {
            const chunk = allVids.slice(i, i + 3);
            if (chunk.length > 0) available.push({ type: 'videos', data: chunk, key: `videos-${Math.floor(i / 3) + 1}-${pageNum}` });
        }
        if (processedAudio.length > 0) available.push({ type: 'audio', data: processedAudio, key: `audio-${pageNum}` });
        if (processedPosts.length > 0) available.push({ type: 'post-single', data: processedPosts[0], key: `post-${pageNum}` });

        // Shuffle sections for YouTube-style session variety
        for (let i = available.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [available[i], available[j]] = [available[j], available[i]];
        }
        sections.push(...available);

        const hasNextPage = pageNum < maxPages && (videosPagination.hasNextPage || false);

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
                hasMoreShorts: processedShorts.length >= shortsLimitNum,
                hasMoreAudio: processedAudio.length >= audioLimitNum,
                hasMoreVideos: videosPagination.hasNextPage || false,
                hasMorePosts: processedPosts.length >= postsLimitNum,
                totals: {
                    shorts: processedShorts.length,
                    audio: processedAudio.length,
                    videos: totalVideos,
                    posts: processedPosts.length
                }
            }
        });

    } catch (error) {
        console.error('[Feed] getMixedFeed error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Returns a combined response with `videos` (similar videos) and `shorts` (recommended shorts).
 * Used by the watch page sidebar and API route `/api/v2/video/:videoId/recommendations-with-shorts`.
 */
export const getRecommendationsWithShorts = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { videoId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const shortsLimit = parseInt(req.query.shortsLimit) || 4;
        const seenIds = req.query.seenIds ? req.query.seenIds.split(',').filter(Boolean) : [];
        const recCategory = req.query.recCategory || 'all';
        const recValue = req.query.recValue || '';

        // Find current video/content
        const current = await Content.findById(videoId)
            .populate('userId', 'channelName channelHandle userName')
            .lean();
        if (!current) return res.status(404).json({ error: 'Content not found' });

        // Similar videos (content-based) for default tab, server-side filtered results for chip tabs
        let videos = [];
        let pagination = { currentPage: page, hasNextPage: false };

        if (recCategory === 'all') {
            const similar = await findSimilarVideos(current, page, limit);
            videos = similar.videos || [];
            pagination = similar.pagination || { currentPage: page, hasNextPage: false };
        } else {
            const filterQuery = {
                _id: { $ne: current._id },
                status: 'completed',
                visibility: 'public',
                contentType: 'video',
            };

            if (recCategory === 'channel') {
                filterQuery.userId = current.userId?._id || current.userId;
            } else if (recCategory === 'category' && recValue) {
                const safe = recValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                filterQuery.category = new RegExp(`^${safe}$`, 'i');
            } else if (recCategory === 'tag' && recValue) {
                const safe = recValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                filterQuery.tags = { $in: [new RegExp(`^${safe}$`, 'i')] };
            }

            const docs = await Content.find(filterQuery)
                .sort({ createdAt: -1, views: -1 })
                .skip((page - 1) * limit)
                .limit(limit + 1)
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .lean();

            const hasNextPage = docs.length > limit;
            const sliced = docs.slice(0, limit);

            videos = sliced.map((video) => ({
                _id: video._id,
                title: video.title,
                description: video.description,
                duration: video.duration,
                thumbnailUrl: getCfUrl(video.thumbnailKey),
                views: video.views,
                createdAt: video.createdAt,
                channelName: video.userId?.channelName || video.channelName || video.userId?.userName || 'Unknown Channel',
                channelPicture: video.userId?.channelPicture || null,
                channelHandle: video.userId?.channelHandle || null,
                tags: video.tags,
                category: video.category,
            }));

            pagination = {
                currentPage: page,
                hasNextPage,
                totalPages: hasNextPage ? page + 1 : page,
            };
        }

        // Short recommendations from watch-history engine (personalised / fallback)
        const shorts = await watchHistoryEngine.getRecommendations(userId, 'short', {
            page: 1,
            limit: shortsLimit,
            excludeIds: seenIds
        });

        res.json({
            videos,
            shorts: shorts.content || [],
            pagination,
            currentVideoChannelName: current.userId?.channelName || current.channelName || current.userId?.userName || 'Unknown Channel',
            currentVideoChannelHandle: current.userId?.channelHandle || null,
        });
    } catch (error) {
        console.error('[Feed] getRecommendationsWithShorts error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get personalized category tags for the dashboard chip bar.
 * Returns an ordered array of category objects:
 *  - "For You" (always first)
 *  - "From Following" (if user has subscriptions)
 *  - "Recently Uploaded"
 *  - Dynamic tags derived from user's watch history (top tags & categories)
 *
 * GET /api/v2/video/feed/categories
 */
export const getCategoryTags = async (req, res) => {
    try {
        const userId = req.user?.id;
        const categories = [];

        // 1. "For You" — always present, default
        categories.push({ id: 'for-you', label: 'For You', type: 'system' });

        // 2. "From Following" — only if user has subscriptions
        if (userId) {
            const user = await User.findById(userId).select('subscriptions').lean();
            if (user?.subscriptions?.length > 0) {
                categories.push({ id: 'following', label: 'From Following', type: 'system' });
            }
        }

        // 3. "Recently Uploaded"
        categories.push({ id: 'recent', label: 'Recently Uploaded', type: 'system' });

        // 4. Dynamic tags from watch history
        if (userId) {
            const history = await WatchHistory.find({ userId })
                .sort({ lastWatchedAt: -1 })
                .limit(200)
                .select('contentMetadata.tags contentMetadata.category watchPercentage completedWatch liked lastWatchedAt')
                .lean();

            if (history.length > 0) {
                const tagScores = {};
                const categoryScores = {};

                for (const item of history) {
                    // Weight: higher watch %, completed, liked, and recency boost score
                    const daysSince = (Date.now() - new Date(item.lastWatchedAt)) / 86400000;
                    const recencyWeight = Math.exp(-daysSince / 14);
                    const engagementWeight = (item.completedWatch ? 1.5 : 1) * (item.liked ? 1.3 : 1);
                    const weight = recencyWeight * engagementWeight;

                    for (const tag of (item.contentMetadata?.tags || [])) {
                        const normalTag = tag.toLowerCase().trim();
                        if (normalTag) tagScores[normalTag] = (tagScores[normalTag] || 0) + weight;
                    }

                    const cat = item.contentMetadata?.category;
                    if (cat) {
                        const normalCat = cat.trim();
                        categoryScores[normalCat] = (categoryScores[normalCat] || 0) + weight;
                    }
                }

                // Top categories (up to 3)
                const topCategories = Object.entries(categoryScores)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3);

                for (const [cat] of topCategories) {
                    const id = `cat-${cat.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
                    if (!categories.some(c => c.id === id)) {
                        categories.push({ id, label: cat, type: 'category', value: cat });
                    }
                }

                // Top tags (up to 5, excluding ones already covered by category)
                const catLabels = new Set(topCategories.map(([c]) => c.toLowerCase()));
                const topTags = Object.entries(tagScores)
                    .filter(([tag]) => !catLabels.has(tag))
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5);

                for (const [tag] of topTags) {
                    const id = `tag-${tag.replace(/[^a-z0-9]+/g, '-')}`;
                    if (!categories.some(c => c.id === id)) {
                        categories.push({ id, label: tag.charAt(0).toUpperCase() + tag.slice(1), type: 'tag', value: tag });
                    }
                }
            }
        }

        // 5. "Trending" — always available at the end
        categories.push({ id: 'trending', label: 'Trending', type: 'system' });

        res.json({ categories });
    } catch (error) {
        console.error('[Feed] getCategoryTags error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get filtered feed content for a specific category tag.
 * Uses the same algorithm infrastructure as getMixedFeed but filters/ranks by category.
 *
 * GET /api/v2/video/feed/category/:categoryId
 * Query params: page, limit, seenIds
 */
export const getCategoryFeed = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { categoryId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 12;
        const seenIds = req.query.seenIds ? req.query.seenIds.split(',').filter(Boolean) : [];
        const excludeIdSet = seenIds.map(id => {
            try { return new mongoose.Types.ObjectId(id); } catch (_) { return null; }
        }).filter(Boolean);

        let query = {
            status: 'completed',
            visibility: 'public',
        };
        if (excludeIdSet.length > 0) query._id = { $nin: excludeIdSet };

        let sortOverride = null;

        // Apply category-specific filters
        if (categoryId === 'for-you') {
            // Use the full recommendation engine — no extra filter
        } else if (categoryId === 'shorts') {
            const result = await watchHistoryEngine.getRecommendations(userId, 'short', {
                page,
                limit,
                excludeIds: seenIds,
            });
            return res.json({
                content: result.content || [],
                pagination: result.pagination || { currentPage: page, hasNextPage: false },
            });
        } else if (categoryId === 'audio') {
            const result = await watchHistoryEngine.getRecommendations(userId, 'audio', {
                page,
                limit,
                excludeIds: seenIds,
            });
            return res.json({
                content: result.content || [],
                pagination: result.pagination || { currentPage: page, hasNextPage: false },
            });
        } else if (categoryId === 'posts') {
            const result = await watchHistoryEngine.getRecommendations(userId, 'post', {
                page,
                limit,
                excludeIds: seenIds,
            });
            return res.json({
                content: result.content || [],
                pagination: result.pagination || { currentPage: page, hasNextPage: false },
            });
        } else if (categoryId === 'following') {
            if (!userId) return res.json({ content: [], pagination: { currentPage: page, hasNextPage: false } });
            const user = await User.findById(userId).select('subscriptions').lean();
            const subIds = (user?.subscriptions || []).map(s => s._id || s);
            if (subIds.length === 0) return res.json({ content: [], pagination: { currentPage: page, hasNextPage: false } });
            query.userId = { $in: subIds };
        } else if (categoryId === 'recent') {
            const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
            query.createdAt = { $gte: threeDaysAgo };
            sortOverride = { createdAt: -1 };
        } else if (categoryId === 'trending') {
            // Trending: high engagement + recent
            const weekAgo = new Date(Date.now() - 7 * 86400000);
            query.createdAt = { $gte: weekAgo };
            sortOverride = { views: -1 };
        } else if (categoryId.startsWith('cat-')) {
            // Category filter
            const catValue = req.query.value || categoryId.replace('cat-', '').replace(/-/g, ' ');
            query.category = new RegExp(`^${catValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        } else if (categoryId.startsWith('tag-')) {
            // Tag filter
            const tagValue = req.query.value || categoryId.replace('tag-', '').replace(/-/g, ' ');
            query.tags = { $in: [new RegExp(`^${tagValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')] };
        } else {
            return res.status(400).json({ error: 'Invalid category' });
        }

        // For 'for-you', use the full recommendation engine
        if (categoryId === 'for-you') {
            const result = await watchHistoryEngine.getRecommendations(userId, 'video', {
                page, limit, excludeIds: seenIds
            });
            return res.json({
                content: result.content || [],
                pagination: result.pagination || { currentPage: page, hasNextPage: false }
            });
        }

        // For other categories, fetch and optionally score
        let candidates;
        if (sortOverride) {
            candidates = await Content.find(query)
                .sort(sortOverride)
                .skip((page - 1) * limit)
                .limit(limit + 1) // +1 to check hasNextPage
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .lean();
        } else {
            candidates = await Content.find(query)
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .lean();
        }

        let results;
        const hasNextPage = sortOverride ? candidates.length > limit : false;
        if (sortOverride) {
            results = candidates.slice(0, limit);
        } else {
            // Score with recommendation engine for non-sorted categories
            const userProfile = userId ? await watchHistoryEngine.buildUserProfile(userId) : null;
            const watchedHistory = userId
                ? await WatchHistory.find({ userId }).select('contentId').lean()
                : [];
            const watchedIds = new Set(watchedHistory.map(h => h.contentId.toString()));

            const scored = candidates.map(c => ({
                ...c,
                recommendationScore: userProfile
                    ? watchHistoryEngine.scoreContent(c, userProfile, watchedIds)
                    : watchHistoryEngine.fallbackScore(c)
            }));
            scored.sort((a, b) => b.recommendationScore - a.recommendationScore);
            const startIdx = (page - 1) * limit;
            results = scored.slice(startIdx, startIdx + limit);
        }

        // Normalize output format (include all fields needed by frontend cards)
        const content = results.map((c) => normalizeFeedItem(c));

        res.json({
            content,
            pagination: {
                currentPage: page,
                hasNextPage: sortOverride ? hasNextPage : ((page - 1) * limit + results.length < candidates.length),
            }
        });
    } catch (error) {
        console.error('[Feed] getCategoryFeed error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Get category-specific trending content.
 * - for-you: mixed trending across all public content
 * - following: trending only from followed creators
 * - shorts/audio/posts: trending within that content type
 */
export const getCategoryTrending = async (req, res) => {
    try {
        const { categoryId } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 5, 20);
        const seenIds = req.query.seenIds ? req.query.seenIds.split(',').filter(Boolean) : [];

        // Dashboard now renders trending only in "for-you".
        if (categoryId !== 'for-you') {
            return res.json({ content: [] });
        }

        const excludeIdSet = seenIds.map((id) => {
            try {
                return new mongoose.Types.ObjectId(id);
            } catch (_) {
                return null;
            }
        }).filter(Boolean);

        const query = {
            status: 'completed',
            visibility: 'public',
            createdAt: { $gte: new Date(Date.now() - 21 * 86400000) },
        };

        if (excludeIdSet.length > 0) {
            query._id = { $nin: excludeIdSet };
        }

        const trendingProjection =
            'contentType title description duration thumbnailKey imageKey hlsMasterKey processedKey originalKey views likeCount likes createdAt channelName status tags category artist album audioCategory postContent userId';

        let candidates = await Content.find(query)
            .select(trendingProjection)
            .sort({ views: -1, createdAt: -1 })
            .limit(150)
            .populate('userId', 'userName channelName channelHandle channelPicture')
            .lean();

        // Fallback: if the recent-window filter produced nothing, retry without recency cutoff.
        if (candidates.length === 0) {
            const relaxedQuery = { ...query };
            delete relaxedQuery.createdAt;
            candidates = await Content.find(relaxedQuery)
                .select(trendingProjection)
                .sort({ views: -1, createdAt: -1 })
                .limit(150)
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .lean();
        }

        if (candidates.length === 0) {
            return res.json({ content: [] });
        }

        const trending = recommendationEngine.getTrendingVideos(candidates, limit);
        const content = trending.map((item) => normalizeFeedItem(item));

        return res.json({ content });
    } catch (error) {
        console.error('[Feed] getCategoryTrending error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
};