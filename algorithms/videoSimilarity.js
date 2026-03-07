// algorithms/videoSimilarity.js

/**
 * Enhanced video similarity and recommendation algorithms
 * 
 * Scoring weights (total = 1.0):
 *  ┌──────────────────────────────┬─────────┐
 *  │ Signal                       │ Weight  │
 *  ├──────────────────────────────┼─────────┤
 *  │ Keyword / tag overlap        │  0.25   │
 *  │ Creator match                │  0.12   │
 *  │ View popularity (log-norm)   │  0.15   │
 *  │ Follower score (log-norm)    │  0.10   │
 *  │ Engagement rate              │  0.12   │
 *  │ Avg watch-time ratio         │  0.10   │
 *  │ Recency (two-tier decay)     │  0.08   │
 *  │ Duration similarity          │  0.05   │
 *  │ New creator boost            │  0.03   │
 *  └──────────────────────────────┴─────────┘
 */

import Content from '../models/content.model.js';
import User from '../models/user.model.js';
import mongoose from 'mongoose';
import { getCfUrl } from '../config/cloudfront.js';

/**
 * Find similar videos with enhanced multi-signal scoring
 */
export const findSimilarVideos = async (currentVideo, page = 1, limit = 10) => {
    try {
        const keywords = extractKeywords(currentVideo);

        const allVideos = await Content.find({
            contentType: 'video',
            status: 'completed',
            _id: { $ne: currentVideo._id }
        }).populate('userId', 'userName channelName channelHandle channelPicture roles createdAt');

        // Batch-fetch follower counts for all candidate creators
        const creatorIds = [...new Set(
            allVideos.map(v => (v.userId?._id || v.userId)?.toString()).filter(Boolean)
        )];
        const followerMap = {};
        if (creatorIds.length > 0) {
            try {
                const creatorObjIds = creatorIds.map(id => new mongoose.Types.ObjectId(id));
                const counts = await User.aggregate([
                    { $match: { subscriptions: { $in: creatorObjIds } } },
                    { $project: { subscriptions: { $filter: { input: '$subscriptions', as: 's', cond: { $in: ['$$s', creatorObjIds] } } } } },
                    { $unwind: '$subscriptions' },
                    { $group: { _id: '$subscriptions', count: { $sum: 1 } } }
                ]);
                for (const { _id, count } of counts) {
                    followerMap[_id.toString()] = count;
                }
            } catch (_) { }
        }

        // Find max views for normalization
        const maxViews = Math.max(1, ...allVideos.map(v => v.views || 0));

        const scoredVideos = allVideos.map(video => {
            const plain = video.toObject();
            const creatorId = (plain.userId?._id || plain.userId)?.toString();
            plain._followerCount = creatorId ? (followerMap[creatorId] || 0) : 0;
            return {
                ...plain,
                similarityScore: calculateSimilarityScore(currentVideo, plain, keywords, maxViews)
            };
        });

        scoredVideos.sort((a, b) => b.similarityScore - a.similarityScore);

        // Diversity: cap same-creator at 3 per result set
        const diversified = [];
        const creatorCount = {};
        for (const v of scoredVideos) {
            const cid = (v.userId?._id || v.userId)?.toString() || 'anon';
            creatorCount[cid] = (creatorCount[cid] || 0) + 1;
            if (creatorCount[cid] <= 3) diversified.push(v);
        }

        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedVideos = diversified.slice(startIndex, endIndex);

        const videosWithUrls = paginatedVideos.map((video) => ({
            _id: video._id,
            title: video.title,
            description: video.description,
            duration: video.duration,
            thumbnailUrl: getCfUrl(video.thumbnailKey),
            views: video.views,
            createdAt: video.createdAt,
            user: video.userId,
            channelName: video.channelName || video.userId?.channelName || video.userId?.userName || 'Unknown Channel',
            channelPicture: video.userId?.channelPicture || null,
            channelHandle: video.userId?.channelHandle || null,
            tags: video.tags,
            category: video.category,
            similarityScore: video.similarityScore
        }));

        const totalVideos = diversified.length;
        const hasNextPage = endIndex < totalVideos;

        return {
            videos: videosWithUrls,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalVideos / limit),
                totalVideos,
                hasNextPage,
                limit
            }
        };
    } catch (error) {
        console.error('Error finding similar videos:', error);
        throw error;
    }
};

/**
 * Extract keywords from video title, description, and tags
 */
const extractKeywords = (video) => {
    const text = `${video.title} ${video.description || ''}`.toLowerCase();
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those'];

    const words = text
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.includes(word));

    // Include tags as keywords too
    const tags = (video.tags || []).map(t => t.toLowerCase());

    return [...new Set([...words, ...tags])];
};

/**
 * Enhanced multi-signal similarity scoring
 */
const calculateSimilarityScore = (video1, video2, keywords1, maxViews) => {
    let score = 0;

    // 1. Keyword / tag overlap (0.25)
    const keywords2 = extractKeywords(video2);
    const commonKeywords = keywords1.filter(keyword => keywords2.includes(keyword));
    const keywordSimilarity = keywords1.length > 0
        ? commonKeywords.length / Math.max(keywords1.length, keywords2.length)
        : 0;
    score += keywordSimilarity * 0.25;

    // 2. Creator match — same creator gets boost (0.12)
    const creator1 = (video1.userId?._id || video1.userId)?.toString();
    const creator2 = (video2.userId?._id || video2.userId)?.toString();
    if (creator1 && creator2 && creator1 === creator2) score += 0.12;

    // 3. View popularity — log-normalized (0.15)
    const views = video2.views || 0;
    const viewScore = maxViews > 0 ? Math.min(1, Math.log10(views + 1) / Math.log10(maxViews + 1)) : 0;
    score += viewScore * 0.15;

    // 4. Follower / creator popularity — log-normalized (0.10)
    const followers = video2._followerCount || 0;
    const followerScore = followers > 0 ? Math.min(1, Math.log10(followers + 1) / 5) : 0.05;
    score += followerScore * 0.10;

    // 5. Engagement rate — (likes + comments*2) / views (0.12)
    const likes = video2.likeCount || video2.likes?.length || 0;
    const comments = video2.commentCount || 0;
    let engagement = 0;
    if (views > 0) {
        engagement = Math.min(1, (likes + comments * 2) / views / 0.1);
    }
    score += engagement * 0.12;

    // 6. Average watch-time ratio (0.10)
    const avgWT = video2.averageWatchTime || 0;
    const dur = video2.duration || 0;
    let watchTimeRatio = 0;
    if (avgWT > 0 && dur > 0) {
        watchTimeRatio = Math.min(avgWT / dur, 1);
    } else if (video2.totalWatchTime > 0 && views > 0 && dur > 0) {
        watchTimeRatio = Math.min((video2.totalWatchTime / views) / dur, 1);
    }
    score += watchTimeRatio * 0.10;

    // 7. Recency — two-tier decay (0.08)
    const hoursOld = (Date.now() - new Date(video2.createdAt)) / 3600000;
    let recencyScore;
    if (hoursOld <= 48) {
        recencyScore = 0.90 + 0.10 * (1 - hoursOld / 48);
    } else {
        const daysOld = hoursOld / 24;
        recencyScore = daysOld <= 30 ? Math.exp(-(daysOld - 2) / 14) : 0.05;
    }
    score += recencyScore * 0.08;

    // 8. Duration similarity (0.05)
    if (video1.duration && video2.duration) {
        const durationDiff = Math.abs(video1.duration - video2.duration);
        const durationSimilarity = Math.max(0, 1 - durationDiff / Math.max(video1.duration, video2.duration));
        score += durationSimilarity * 0.05;
    }

    // 9. New creator boost — channels < 30 days old, < 100 followers (0.03)
    const channelCreatedAt = video2.userId?.createdAt;
    if (channelCreatedAt) {
        const channelAgeDays = (Date.now() - new Date(channelCreatedAt)) / 86400000;
        if (channelAgeDays < 30 && followers < 100) {
            score += 0.03;
        }
    }

    // Random jitter for session diversity
    score += Math.random() * 0.02;

    return Math.min(score, 1);
};