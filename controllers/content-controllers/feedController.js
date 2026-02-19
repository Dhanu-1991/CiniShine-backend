// controllers/content-controllers/feedController.js

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import Comment from '../../models/comment.model.js';
import { watchHistoryEngine } from '../../algorithms/watchHistoryRecommendation.js';
import { recommendationEngine } from '../../algorithms/recommendationAlgorithm.js';
import { findSimilarVideos } from '../../algorithms/videoSimilarity.js';
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

        // ── Section layout (unchanged from before) ────────────────────────
        const videosBatch1 = processedVideos.slice(0, 3);
        const videosBatch2 = processedVideos.slice(3, 6);
        const videosBatch3 = processedVideos.slice(6, 9);
        const videosBatch4 = processedVideos.slice(9, 12);

        const sections = [];

        if (isFirstPage) {
            if (processedShorts.length > 0) sections.push({ type: 'shorts', data: processedShorts, key: `shorts-${pageNum}` });
            if (videosBatch1.length > 0) sections.push({ type: 'videos', data: videosBatch1, key: `videos-1-${pageNum}` });
            if (videosBatch2.length > 0) sections.push({ type: 'videos', data: videosBatch2, key: `videos-2-${pageNum}` });
            if (processedAudio.length > 0) sections.push({ type: 'audio', data: processedAudio, key: `audio-${pageNum}` });
            if (videosBatch3.length > 0) sections.push({ type: 'videos', data: videosBatch3, key: `videos-3-${pageNum}` });
            if (videosBatch4.length > 0) sections.push({ type: 'videos', data: videosBatch4, key: `videos-4-${pageNum}` });
            if (processedPosts.length > 0) sections.push({ type: 'post-single', data: processedPosts[0], key: `post-${pageNum}` });
        } else {
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

        // Find current video/content
        const current = await Content.findById(videoId).lean();
        if (!current) return res.status(404).json({ error: 'Content not found' });

        // Similar videos (content-based)
        const similar = await findSimilarVideos(current, page, limit);

        // Short recommendations from watch-history engine (personalised / fallback)
        const shorts = await watchHistoryEngine.getRecommendations(userId, 'short', {
            page: 1,
            limit: shortsLimit,
            excludeIds: seenIds
        });

        res.json({
            videos: similar.videos || [],
            shorts: shorts.content || [],
            pagination: similar.pagination || { currentPage: page, hasNextPage: false }
        });
    } catch (error) {
        console.error('[Feed] getRecommendationsWithShorts error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};



