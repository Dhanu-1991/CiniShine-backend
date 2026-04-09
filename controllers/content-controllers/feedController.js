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
    const thumbnailKey = c.thumbnailKey || c.imageKey || null;

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
        thumbnailUrl: thumbnailKey ? getCfUrl(thumbnailKey) : null,
        imageUrl: c.imageKey ? getCfUrl(c.imageKey) : (thumbnailKey ? getCfUrl(thumbnailKey) : null),
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

        const parsedPage = parseInt(page, 10);
        const pageNum = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
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

        const toSafeLimit = (value, fallback) => {
            const parsed = parseInt(value, 10);
            if (!Number.isFinite(parsed)) return fallback;
            return Math.max(parsed, 0);
        };

        const shortsLimitNum = toSafeLimit(shortsLimit, 5);
        const audioLimitNum = toSafeLimit(audioLimit, 5);
        const videosLimitNum = toSafeLimit(videosLimit, 12);
        const postsLimitNum = toSafeLimit(postsLimit, 1);

        // IDs the client already has — excludes them so backend won't return duplicates
        const excludeIds = seenIds ? seenIds.split(',').filter(Boolean) : [];

        // ── Algorithm-driven parallel fetch ───────────────────────────────
        // watchHistoryEngine scores by full watch-history profile for auth users.
        // For guests it applies recency + popularity + engagement + jitter fallback.
        // This completely replaces the old views-only database sort.
        const emptyResultForPage = (currentPage) => ({
            content: [],
            pagination: {
                currentPage,
                totalPages: 0,
                totalItems: 0,
                hasNextPage: false,
            },
        });

        const [shortsResult, videosResult, audioResult, postsResult] = await Promise.all([
            shortsLimitNum > 0
                ? watchHistoryEngine.getRecommendations(userId, 'short', {
                    page: 1,
                    limit: shortsLimitNum,
                    excludeIds,
                })
                : Promise.resolve(emptyResultForPage(1)),
            videosLimitNum > 0
                ? watchHistoryEngine.getRecommendations(userId, 'video', {
                    page: pageNum,
                    limit: videosLimitNum,
                    excludeIds,
                })
                : Promise.resolve(emptyResultForPage(pageNum)),
            audioLimitNum > 0
                ? watchHistoryEngine.getRecommendations(userId, 'audio', {
                    page: 1,
                    limit: audioLimitNum,
                    excludeIds,
                })
                : Promise.resolve(emptyResultForPage(1)),
            postsLimitNum > 0
                ? watchHistoryEngine.getRecommendations(userId, 'post', {
                    page: 1,
                    limit: postsLimitNum,
                    excludeIds,
                })
                : Promise.resolve(emptyResultForPage(1)),
        ]);

        // Engine already generates CloudFront URLs and normalises all fields
        const processedShorts = shortsResult.content || [];
        const processedVideos = videosResult.content || [];
        const processedAudio = audioResult.content || [];
        const processedPosts = postsResult.content || [];

        const videosPagination = videosResult.pagination || {};
        const totalVideos = videosPagination.totalItems || processedVideos.length;

        // ── Section layout — deterministic balanced order ─────────────────
        const sections = [];
        const videoBlocks = [];
        for (let i = 0; i < processedVideos.length; i += 6) {
            const chunk = processedVideos.slice(i, i + 6);
            if (chunk.length > 0) {
                videoBlocks.push({
                    type: 'videos',
                    data: chunk,
                    key: `videos-${Math.floor(i / 6) + 1}-${pageNum}`
                });
            }
        }

        const supplementCycle = [
            { key: 'shorts', type: 'shorts', limit: 5 },
            { key: 'audio', type: 'audio', limit: 5 },
            { key: 'posts', type: 'post-single', limit: 1 },
        ];

        const supplementState = {
            shorts: [...processedShorts],
            audio: [...processedAudio],
            posts: [...processedPosts],
        };

        let supplementIndex = 0;
        let blockIndex = 0;

        const hasSupplementContent = () =>
            supplementState.shorts.length > 0 || supplementState.audio.length > 0 || supplementState.posts.length > 0;

        while (blockIndex < videoBlocks.length || hasSupplementContent()) {
            if (blockIndex < videoBlocks.length) {
                sections.push(videoBlocks[blockIndex]);
                blockIndex += 1;
            }

            if (!hasSupplementContent()) {
                continue;
            }

            let selectedSupplement = null;
            for (let step = 0; step < supplementCycle.length; step++) {
                const candidate = supplementCycle[(supplementIndex + step) % supplementCycle.length];
                const queue = supplementState[candidate.key];

                if (queue.length > 0) {
                    selectedSupplement = candidate;
                    supplementIndex = (supplementIndex + step + 1) % supplementCycle.length;
                    break;
                }
            }

            if (!selectedSupplement) {
                continue;
            }

            const queue = supplementState[selectedSupplement.key];
            const items = queue.splice(0, selectedSupplement.limit);

            if (items.length === 0) {
                continue;
            }

            sections.push({
                type: selectedSupplement.type,
                data: selectedSupplement.type === 'post-single' ? items[0] : items,
                key: `${selectedSupplement.key}-${pageNum}-${sections.length}`
            });
        }

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
 * Returns a combined response with `videos` (similar videos), `shorts`, and `audio` recommendations.
 * Used by the watch page sidebar and API route `/api/v2/video/:videoId/recommendations-with-shorts`.
 */
export const getRecommendationsWithShorts = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { videoId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const parsedShortsLimit = parseInt(req.query.shortsLimit, 10);
        const parsedAudioLimit = parseInt(req.query.audioLimit, 10);
        const MAX_SUPPLEMENTAL_LIMIT = 12;
        const shortsLimit = Number.isNaN(parsedShortsLimit)
            ? 4
            : Math.min(MAX_SUPPLEMENTAL_LIMIT, Math.max(0, parsedShortsLimit));
        const audioLimit = Number.isNaN(parsedAudioLimit)
            ? 4
            : Math.min(MAX_SUPPLEMENTAL_LIMIT, Math.max(0, parsedAudioLimit));
        const seenIds = req.query.seenIds ? req.query.seenIds.split(',').filter(Boolean) : [];
        const recCategory = req.query.recCategory || 'all';
        const recValue = req.query.recValue || '';

        // Find current video/content
        const current = await Content.findById(videoId)
            .populate('userId', 'channelName channelHandle userName')
            .lean();
        if (!current) return res.status(404).json({ error: 'Content not found' });

        // Build user profile once so all content types can receive explicit history weighting.
        const userProfile = userId ? await watchHistoryEngine.buildUserProfile(userId) : null;

        const normalise = (value) => String(value || '').trim().toLowerCase();
        const currentId = current._id?.toString();
        const baseExcludedIds = new Set(seenIds.map((id) => id.toString()));
        if (currentId) baseExcludedIds.add(currentId);

        const normalizedPreferredTags = {};
        const normalizedPreferredCategories = {};
        if (userProfile) {
            for (const [key, score] of Object.entries(userProfile.preferredTags || {})) {
                const normalizedKey = normalise(key);
                if (!normalizedKey) continue;
                normalizedPreferredTags[normalizedKey] = Math.max(normalizedPreferredTags[normalizedKey] || 0, score || 0);
            }
            for (const [key, score] of Object.entries(userProfile.preferredCategories || {})) {
                const normalizedKey = normalise(key);
                if (!normalizedKey) continue;
                normalizedPreferredCategories[normalizedKey] = Math.max(normalizedPreferredCategories[normalizedKey] || 0, score || 0);
            }
        }

        const getHistoryProfileBoost = (item) => {
            if (!userProfile) return 0;

            const tags = (item.tags || []).map((t) => normalise(t)).filter(Boolean);
            const category = normalise(item.category);
            const creatorId = (item.userId?._id || item.userId || item.creatorId)?.toString();
            const contentType = normalise(item.contentType);

            let tagBoost = 0;
            for (const tag of tags) {
                const exact = normalizedPreferredTags[tag];
                if (exact) tagBoost += exact;
            }

            const categoryBoost = category && normalizedPreferredCategories[category]
                ? normalizedPreferredCategories[category]
                : 0;

            const creatorBoost = creatorId && userProfile.preferredCreators?.[creatorId]
                ? userProfile.preferredCreators[creatorId]
                : 0;

            const typeBoost = contentType && userProfile.preferredContentTypes?.[contentType]
                ? userProfile.preferredContentTypes[contentType]
                : 0;

            // Normalize each component and keep total boost bounded.
            return (
                Math.min(tagBoost, 1) * 0.40 +
                Math.min(categoryBoost, 1) * 0.20 +
                Math.min(creatorBoost, 1) * 0.30 +
                Math.min(typeBoost, 1) * 0.10
            );
        };

        // Similar videos (content-based) for default tab, server-side filtered results for chip tabs
        let videos = [];
        let pagination = { currentPage: page, hasNextPage: false };

        if (recCategory === 'all') {
            const similar = await findSimilarVideos(current, page, limit);
            const similarVideos = similar.videos || [];

            // Blend similarity feed with watch-history feed so watch behavior influences watch sidebar videos.
            // Use a larger candidate pool then rerank deterministically.
            let historyVideos = [];
            if (userId) {
                const historyResult = await watchHistoryEngine.getRecommendations(userId, 'video', {
                    page,
                    limit: Math.max(limit * 2, 20),
                    excludeIds: Array.from(baseExcludedIds)
                });
                historyVideos = (historyResult.content || []).map((item) => ({
                    ...item,
                    _historyScore: item.recommendationScore || 0
                }));
            }

            const byId = new Map();
            for (const item of similarVideos) {
                byId.set(item._id.toString(), {
                    ...item,
                    contentType: 'video',
                    _similarityScore: item.similarityScore || 0,
                    _historyScore: 0,
                });
            }
            for (const item of historyVideos) {
                const key = item._id.toString();
                const existing = byId.get(key);
                if (!existing) {
                    byId.set(key, {
                        ...item,
                        contentType: 'video',
                        _similarityScore: 0,
                        _historyScore: item._historyScore || 0,
                    });
                } else {
                    existing._historyScore = Math.max(existing._historyScore || 0, item._historyScore || 0);
                }
            }

            const merged = [...byId.values()];
            const maxSimilarity = Math.max(0.0001, ...merged.map((v) => v._similarityScore || 0));
            const maxHistory = Math.max(0.0001, ...merged.map((v) => v._historyScore || 0));

            videos = merged
                .map((item) => {
                    const normalizedSimilarity = (item._similarityScore || 0) / maxSimilarity;
                    const normalizedHistory = (item._historyScore || 0) / maxHistory;
                    const profileBoost = getHistoryProfileBoost(item);

                    // Final blend: similarity remains primary for context, history adds personalization.
                    const blendedScore = normalizedSimilarity * 0.55 + normalizedHistory * 0.35 + profileBoost * 0.10;

                    return {
                        ...item,
                        blendedScore,
                    };
                })
                .sort((a, b) => b.blendedScore - a.blendedScore)
                .slice(0, limit)
                .map((item) => ({
                    _id: item._id,
                    title: item.title,
                    description: item.description,
                    duration: item.duration,
                    thumbnailUrl: item.thumbnailUrl,
                    views: item.views,
                    createdAt: item.createdAt,
                    channelName: item.channelName,
                    channelPicture: item.channelPicture || null,
                    channelHandle: item.channelHandle || null,
                    tags: item.tags,
                    category: item.category,
                }));

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

        const getRelatedSupplementalContent = async (contentType, requestedLimit) => {
            const safeLimit = Math.max(0, parseInt(requestedLimit, 10) || 0);
            if (safeLimit === 0) return [];

            const excluded = new Set(baseExcludedIds);

            const currentChannelId = (current.userId?._id || current.userId)?.toString();
            const currentCategory = String(current.category || '').trim().toLowerCase();
            const currentAudioCategory = String(current.audioCategory || '').trim().toLowerCase();
            const currentTags = new Set((current.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));

            const relatedCandidates = await Content.find({
                _id: { $nin: Array.from(excluded) },
                status: 'completed',
                visibility: 'public',
                contentType
            })
                .sort({ createdAt: -1, views: -1 })
                .limit(160)
                .populate('userId', 'userName channelName channelHandle channelPicture')
                .lean();

            const scoredRelated = relatedCandidates
                .map((item) => {
                    const itemChannelId = (item.userId?._id || item.userId)?.toString();
                    const itemCategory = String(item.category || '').trim().toLowerCase();
                    const itemAudioCategory = String(item.audioCategory || '').trim().toLowerCase();
                    const itemTags = (item.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);

                    const overlapCount = itemTags.reduce((acc, tag) => acc + (currentTags.has(tag) ? 1 : 0), 0);
                    const hasCategoryMatch = Boolean(
                        (currentCategory && itemCategory && currentCategory === itemCategory) ||
                        (currentAudioCategory && itemAudioCategory && currentAudioCategory === itemAudioCategory)
                    );
                    const hasCreatorMatch = Boolean(currentChannelId && itemChannelId && currentChannelId === itemChannelId);
                    const views = item.views || 0;
                    const hoursOld = (Date.now() - new Date(item.createdAt)) / 3600000;

                    let score = 0;
                    if (hasCreatorMatch) score += 3.5;
                    if (hasCategoryMatch) score += 2.5;
                    if (overlapCount > 0) score += Math.min(overlapCount, 4) * 1.4;
                    score += Math.min(views / 10000, 1);
                    score += Math.max(0, 1 - hoursOld / (24 * 14));
                    score += getHistoryProfileBoost(item) * 2.8;

                    return {
                        item,
                        score,
                        hasStrongRelation: hasCreatorMatch || hasCategoryMatch || overlapCount > 0
                    };
                })
                .filter((entry) => entry.hasStrongRelation)
                .sort((a, b) => b.score - a.score);

            const relatedItems = [];
            const usedIds = new Set();
            for (const entry of scoredRelated) {
                if (relatedItems.length >= safeLimit) break;
                const id = entry.item._id?.toString();
                if (!id || usedIds.has(id)) continue;
                relatedItems.push(normalizeFeedItem(entry.item));
                usedIds.add(id);
                excluded.add(id);
            }

            if (relatedItems.length < safeLimit) {
                const fallback = await watchHistoryEngine.getRecommendations(userId, contentType, {
                    page: 1,
                    limit: safeLimit * 2,
                    excludeIds: Array.from(excluded)
                });

                for (const item of fallback.content || []) {
                    if (relatedItems.length >= safeLimit) break;
                    const id = item._id?.toString();
                    if (!id || usedIds.has(id)) continue;
                    relatedItems.push(item);
                    usedIds.add(id);
                }
            }

            return relatedItems;
        };

        const [shorts, audio] = await Promise.all([
            getRelatedSupplementalContent('short', shortsLimit),
            getRelatedSupplementalContent('audio', audioLimit)
        ]);

        res.json({
            videos,
            shorts,
            audio,
            pagination,
            limits: {
                videos: limit,
                shorts: shortsLimit,
                audio: audioLimit,
            },
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