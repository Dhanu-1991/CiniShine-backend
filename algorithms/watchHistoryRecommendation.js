/**
 * watchHistoryRecommendation.js — PERSONALIZED RECOMMENDATION ENGINE
 *
 * ═══════════════════════════════════════════════════════════════
 * HOW THE RECOMMENDATION ALGORITHM WORKS:
 * ═══════════════════════════════════════════════════════════════
 *
 * This is the PRIMARY algorithm used by:
 *   - ShortsPlayer feed (getShortsPlayerFeed)
 *   - AudioPlayer feed (getAudioPlayerFeed)
 *   - Post feed (getSubscriptionPosts)
 *
 * STEP 1: Build user profile from last 100 WatchHistory records
 *   - Extracts preferred: tags, categories, creators, content types
 *   - Each preference weighted by:
 *     recencyWeight (14-day half-life exponential decay) ×
 *     engagementWeight (completion bonus + like bonus + comment bonus + share bonus + rewatch bonus)
 *
 * STEP 2: Score candidate content against user profile
 *   - Tag match:        25% weight
 *   - Category match:   15% weight
 *   - Creator match:    20% weight
 *   - Watch time engagement: 15% weight
 *   - Completion bonus: 10% weight
 *   - Interaction weight: 15% weight
 *   - PLUS: popularity boost (views/10000), recency boost (30-day decay), random diversity (5%)
 *   - Already-watched content gets 70% PENALTY (score × 0.3) — deprioritized but not excluded
 *
 * STEP 3: Fallback for users with no history
 *   - 40% popularity + 40% recency + 15% engagement + 5% random
 *
 * USED BY: Shorts infinite scroll, Audio next-up, Post feed
 * NOT USED BY: Video recommendations (those use videoSimilarity.js + recommendationAlgorithm.js)
 *
 * IMPORTANT: The algorithm uses tags, categories, and like/dislike status of the
 * CURRENT content to find similar next recommendations. On infinite scroll,
 * excludeIds prevents duplicates, and the algorithm scores new candidates
 * against the user's evolving preference profile.
 * ═══════════════════════════════════════════════════════════════
 */

import mongoose from 'mongoose';
import WatchHistory from '../models/watchHistory.model.js';
import Content from '../models/content.model.js';
import Comment from '../models/comment.model.js';
import User from '../models/user.model.js';
import { getCfUrl, getCfHlsMasterUrl } from '../config/cloudfront.js';

/**
 * WatchHistoryRecommendationEngine
 * Analyzes user's watch history to provide personalized recommendations
 */
export class WatchHistoryRecommendationEngine {
    constructor() {
        this.weights = {
            // ── Personalisation (profile-matching) ──
            tagMatch: 0.12,
            categoryMatch: 0.08,
            creatorMatch: 0.15,

            // ── Content quality signals ──
            avgWatchTimeRatio: 0.20,   // strongest signal (YouTube confirmed)
            engagementRate: 0.12,
            creatorPopularity: 0.08,
            recency: 0.10,

            // ── Exploration & diversity ──
            newContentBoost: 0.05,
            randomJitter: 0.05,
            popularityBaseline: 0.05
        };
    }

    /**
     * Analyze user's watch history to build preference profile
     */
    async buildUserProfile(userId) {
        const history = await WatchHistory.find({ userId })
            .sort({ lastWatchedAt: -1 })
            .limit(100); // Last 100 watched items

        if (history.length === 0) {
            return null;
        }

        const profile = {
            preferredTags: {},
            preferredCategories: {},
            preferredCreators: {},
            preferredContentTypes: {},
            avgWatchPercentage: 0,
            totalWatchTime: 0,
            completedCount: 0
        };

        let totalWatchPercentage = 0;

        for (const item of history) {
            // Weight based on recency and engagement
            const recencyWeight = this.calculateRecencyWeight(item.lastWatchedAt);
            const engagementWeight = this.calculateEngagementWeight(item);
            const weight = recencyWeight * engagementWeight;

            // Tags
            if (item.contentMetadata?.tags) {
                for (const tag of item.contentMetadata.tags) {
                    profile.preferredTags[tag] = (profile.preferredTags[tag] || 0) + weight;
                }
            }

            // Category
            if (item.contentMetadata?.category) {
                profile.preferredCategories[item.contentMetadata.category] =
                    (profile.preferredCategories[item.contentMetadata.category] || 0) + weight;
            }

            // Creator
            if (item.contentMetadata?.creatorId) {
                const creatorId = item.contentMetadata.creatorId.toString();
                profile.preferredCreators[creatorId] =
                    (profile.preferredCreators[creatorId] || 0) + weight;
            }

            // Content type
            profile.preferredContentTypes[item.contentType] =
                (profile.preferredContentTypes[item.contentType] || 0) + weight;

            // Metrics
            totalWatchPercentage += item.watchPercentage || 0;
            profile.totalWatchTime += item.watchTime || 0;
            if (item.completedWatch) profile.completedCount++;
        }

        profile.avgWatchPercentage = totalWatchPercentage / history.length;

        // Normalize and sort preferences
        profile.topTags = this.getTopItems(profile.preferredTags, 10);
        profile.topCategories = this.getTopItems(profile.preferredCategories, 5);
        profile.topCreators = this.getTopItems(profile.preferredCreators, 10);
        profile.topContentTypes = this.getTopItems(profile.preferredContentTypes, 4);

        return profile;
    }

    /**
     * Calculate recency weight (newer = higher weight)
     */
    calculateRecencyWeight(lastWatchedAt) {
        const daysSinceWatch = (Date.now() - new Date(lastWatchedAt)) / (1000 * 60 * 60 * 24);
        // Exponential decay: items from last 7 days get highest weight
        return Math.exp(-daysSinceWatch / 14); // Half-life of 14 days
    }

    /**
     * Calculate engagement weight based on user interactions
     */
    calculateEngagementWeight(historyItem) {
        let weight = 1;

        // Watch completion boost
        if (historyItem.completedWatch) weight += 0.5;
        else weight += (historyItem.watchPercentage || 0) / 200; // Up to 0.5 boost

        // Interaction boosts
        if (historyItem.liked) weight += 0.3;
        if (historyItem.commented) weight += 0.4;
        if (historyItem.shared) weight += 0.5;

        // Dislike penalty
        if (historyItem.disliked) weight *= 0.3;

        // Rewatch bonus
        if (historyItem.watchCount > 1) {
            weight += Math.min(historyItem.watchCount * 0.1, 0.5);
        }

        return weight;
    }

    /**
     * Get top N items from a preference map
     */
    getTopItems(map, n) {
        return Object.entries(map)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([item, score]) => ({ item, score }));
    }

    /**
     * Score a content item against user profile.
     * Combines personalisation signals (tag/category/creator match from history)
     * with content quality signals (avgWatchTime, engagement, creator popularity,
     * recency) and exploration jitter for YouTube-like diversity.
     *
     * Weight budget (sums to 1.0):
     *   Personalisation  35%  (tag 12 + category 8 + creator 15)
     *   Quality          50%  (avgWatchTime 20 + engagement 12 + creatorPop 8 + recency 10)
     *   Exploration      15%  (newContent 5 + popularity 5 + random 5)
     */
    scoreContent(content, userProfile, watchedIds) {
        const w = this.weights;
        let score = 0;
        const isWatched = watchedIds.has(content._id.toString());

        // ── Personalisation signals (user profile matching) ──

        // Tag matching (capped at 1.0 before weighting)
        const contentTags = content.tags || [];
        let tagScore = 0;
        for (const tag of contentTags) {
            if (userProfile.preferredTags[tag]) {
                tagScore += userProfile.preferredTags[tag];
            }
        }
        score += Math.min(tagScore, 1) * w.tagMatch;

        // Category matching
        if (content.category && userProfile.preferredCategories[content.category]) {
            score += Math.min(userProfile.preferredCategories[content.category], 1) * w.categoryMatch;
        }

        // Creator matching (prefer creators user already watches)
        const creatorId = (content.userId?._id || content.userId)?.toString();
        if (creatorId && userProfile.preferredCreators[creatorId]) {
            score += Math.min(userProfile.preferredCreators[creatorId], 1) * w.creatorMatch;
        }

        // ── Content quality signals ──

        // Average watch-time ratio — strongest quality signal
        const avgWT = content.averageWatchTime || 0;
        const dur = content.duration || 0;
        let watchTimeRatio = 0;
        if (avgWT > 0 && dur > 0) {
            watchTimeRatio = Math.min(avgWT / dur, 1);
        } else if (content.totalWatchTime > 0 && content.views > 0 && dur > 0) {
            watchTimeRatio = Math.min((content.totalWatchTime / content.views) / dur, 1);
        }
        score += watchTimeRatio * w.avgWatchTimeRatio;

        // Engagement rate: (likes + comments×2) / views, log-capped
        const views = content.views || 0;
        const likes = content.likeCount || 0;
        const comments = content._commentCount || 0;
        let engagement = 0;
        if (views > 0) {
            engagement = Math.min(1, (likes + comments * 2) / views / 0.1);
        }
        score += engagement * w.engagementRate;

        // Creator popularity (follower count, log-normalised)
        const followers = content._followerCount || 0;
        const creatorPop = followers > 0
            ? Math.min(1, Math.log10(followers + 1) / 5)
            : 0.05;
        score += creatorPop * w.creatorPopularity;

        // Recency: two-tier decay (fresh < 48 h gets big boost)
        const hoursOld = (Date.now() - new Date(content.createdAt)) / 3600000;
        let recencyScore;
        if (hoursOld <= 48) {
            recencyScore = 0.90 + 0.10 * (1 - hoursOld / 48);
        } else {
            const daysOld = hoursOld / 24;
            recencyScore = daysOld <= 30 ? Math.exp(-(daysOld - 2) / 14) : 0.05;
        }
        score += recencyScore * w.recency;

        // ── Exploration & diversity ──

        // New content boost (< 24 h old)
        if (hoursOld < 24) {
            score += (1 - hoursOld / 24) * w.newContentBoost;
        }

        // Popularity baseline (views, soft-capped)
        score += Math.min(views / 10000, 1) * w.popularityBaseline;

        // Random jitter for session diversity
        score += Math.random() * w.randomJitter;

        // ── Penalties ──

        // Deprioritize already-watched content (70% penalty)
        if (isWatched) {
            score *= 0.3;
        }

        return score;
    }

    /**
     * Get personalized recommendations for a specific content type
     */
    async getRecommendations(userId, contentType, options = {}) {
        const { page = 1, limit = 10, excludeIds = [] } = options;

        // Build user profile
        const userProfile = await this.buildUserProfile(userId);

        // Get watched content IDs (for deprioritization, not exclusion)
        const watchedHistory = await WatchHistory.find({ userId, contentType })
            .select('contentId')
            .lean();
        const watchedIds = new Set(
            watchedHistory.map(h => h.contentId.toString())
        );
        // excludeIds are truly excluded (already loaded in frontend)
        const excludeIdSet = new Set(excludeIds.map(id => id.toString()));

        let candidates = [];

        // All content types now use the unified Content model
        // Only exclude the IDs the frontend already has (not watched ones)
        candidates = await Content.find({
            contentType,
            status: 'completed',
            visibility: 'public',
            _id: { $nin: Array.from(excludeIdSet) }
        })
            .populate('userId', 'userName channelName channelPicture')
            .lean();

        // ── Enrich candidates with creator follower counts (single batch query) ──
        const creatorIds = [...new Set(
            candidates.map(c => (c.userId?._id || c.userId)?.toString()).filter(Boolean)
        )];
        const followerMap = {};
        if (creatorIds.length > 0) {
            try {
                const creatorObjIds = creatorIds.map(id =>
                    new mongoose.Types.ObjectId(id)
                );
                const counts = await User.aggregate([
                    { $match: { subscriptions: { $in: creatorObjIds } } },
                    {
                        $project: {
                            subscriptions: {
                                $filter: {
                                    input: '$subscriptions', as: 's',
                                    cond: { $in: ['$$s', creatorObjIds] }
                                }
                            }
                        }
                    },
                    { $unwind: '$subscriptions' },
                    { $group: { _id: '$subscriptions', count: { $sum: 1 } } }
                ]);
                for (const { _id, count } of counts) {
                    followerMap[_id.toString()] = count;
                }
            } catch (_) {
                // Non-fatal: scoring still works without follower data
            }
        }

        // Batch-fetch comment counts for scoring (single aggregation)
        const commentCountMap = {};
        const contentIds = candidates.map(c => c._id);
        if (contentIds.length > 0) {
            try {
                const commentAgg = await Comment.aggregate([
                    { $match: { videoId: { $in: contentIds }, onModel: 'Content', parentCommentId: null } },
                    { $group: { _id: '$videoId', count: { $sum: 1 } } }
                ]);
                for (const { _id, count } of commentAgg) {
                    commentCountMap[_id.toString()] = count;
                }
            } catch (_) { }
        }

        // Attach enrichment data to each candidate
        for (const c of candidates) {
            const cid = (c.userId?._id || c.userId)?.toString();
            c._followerCount = cid ? (followerMap[cid] || 0) : 0;
            c._commentCount = commentCountMap[c._id.toString()] || 0;
        }

        // ── Score with full algorithm ──
        let scoredContent;
        if (userProfile) {
            scoredContent = candidates.map(content => ({
                ...content,
                recommendationScore: this.scoreContent(content, userProfile, watchedIds)
            }));
        } else {
            // No history — fallback: avgWatchTime + recency + engagement + followers + random
            scoredContent = candidates.map(content => ({
                ...content,
                recommendationScore: this.fallbackScore(content)
            }));
        }

        // ── Score-band shuffle for YouTube-like controlled randomness ──
        scoredContent = this.scoreBandShuffle(scoredContent);

        // Paginate
        const startIdx = (page - 1) * limit;
        const paginatedContent = scoredContent.slice(startIdx, startIdx + limit);

        // Generate URLs and get comment counts
        const contentWithUrls = await Promise.all(
            paginatedContent.map(async (content) => {
                // Get comment count for this content
                const commentCount = await Comment.countDocuments({
                    videoId: content._id,
                    onModel: 'Content',
                    parentCommentId: null
                });

                // Generate video/audio URL for shorts and audio (CloudFront)
                let videoUrl = null;
                let hlsMasterUrl = null;
                let audioUrl = null;
                if (contentType === 'short') {
                    hlsMasterUrl = content.hlsMasterKey ? getCfHlsMasterUrl(content.hlsMasterKey) : null;
                    const videoKey = content.hlsMasterKey || content.processedKey || content.originalKey;
                    videoUrl = getCfUrl(videoKey);
                } else if (contentType === 'audio') {
                    const audioKey = content.processedKey || content.originalKey;
                    audioUrl = getCfUrl(audioKey);
                }

                return {
                    _id: content._id,
                    contentType: contentType,
                    title: content.title,
                    description: content.description,
                    duration: content.duration,
                    thumbnailUrl: getCfUrl(content.thumbnailKey),
                    imageUrl: content.imageKey ? getCfUrl(content.imageKey) : null,
                    hlsMasterUrl,
                    videoUrl,
                    audioUrl,
                    views: content.views,
                    likeCount: content.likeCount || content.likes?.length || 0,
                    commentCount,
                    createdAt: content.createdAt,
                    channelName: content.channelName || content.userId?.channelName || content.userId?.userName || 'Unknown',
                    channelPicture: content.userId?.channelPicture || null,
                    userId: content.userId?._id || content.userId,
                    status: content.status,
                    tags: content.tags,
                    artist: content.artist,
                    album: content.album,
                    audioCategory: content.audioCategory,
                    postContent: content.postContent,
                    recommendationScore: content.recommendationScore
                };
            })
        );

        return {
            content: contentWithUrls,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(scoredContent.length / limit),
                totalItems: scoredContent.length,
                hasNextPage: startIdx + limit < scoredContent.length
            }
        };
    }

    /**
     * Fallback scoring for users without watch history (guests / new users).
     * Uses content quality signals only — no personalisation.
     *
     * avgWatchTimeRatio 25% | recency 22% | engagement 15%
     * creatorPopularity 10% | views 10% | newContentBoost 8% | random 10%
     */
    fallbackScore(content) {
        let score = 0;

        // Average watch-time ratio (strongest quality signal even for guests)
        const avgWT = content.averageWatchTime || 0;
        const dur = content.duration || 0;
        if (avgWT > 0 && dur > 0) {
            score += Math.min(avgWT / dur, 1) * 0.25;
        } else if (content.totalWatchTime > 0 && content.views > 0 && dur > 0) {
            score += Math.min((content.totalWatchTime / content.views) / dur, 1) * 0.25;
        }

        // Recency (two-tier decay like YouTube)
        const hoursOld = (Date.now() - new Date(content.createdAt)) / 3600000;
        if (hoursOld <= 48) {
            score += (0.90 + 0.10 * (1 - hoursOld / 48)) * 0.22;
        } else {
            const daysOld = hoursOld / 24;
            score += (daysOld <= 30 ? Math.exp(-(daysOld - 2) / 14) : 0.05) * 0.22;
        }

        // Engagement rate: likes / views
        const views = content.views || 0;
        const likes = content.likeCount || 0;
        if (views > 0) {
            score += Math.min(1, likes / views / 0.05) * 0.15;
        }

        // Creator popularity (follower count, log-normalised)
        const followers = content._followerCount || 0;
        score += (followers > 0 ? Math.min(1, Math.log10(followers + 1) / 5) : 0.05) * 0.10;

        // Popularity baseline (views, soft-capped)
        score += Math.min(views / 10000, 1) * 0.10;

        // New content boost (< 24 h)
        if (hoursOld < 24) {
            score += (1 - hoursOld / 24) * 0.08;
        }

        // Random jitter for discovery / freshness
        score += Math.random() * 0.10;

        return score;
    }

    /**
     * Shuffle items within score bands for session diversity.
     * Groups items into bands of ~0.05 score width, shuffles within each band.
     * Ensures top-quality content stays near the top while varying exact order.
     */
    scoreBandShuffle(items) {
        if (items.length <= 1) return items;

        // Sort by score descending first
        items.sort((a, b) => b.recommendationScore - a.recommendationScore);

        const bandWidth = 0.05;
        const result = [];
        let bandStart = 0;

        while (bandStart < items.length) {
            const bandThreshold = items[bandStart].recommendationScore - bandWidth;
            let bandEnd = bandStart + 1;
            while (bandEnd < items.length && items[bandEnd].recommendationScore >= bandThreshold) {
                bandEnd++;
            }

            // Fisher-Yates shuffle within this band
            const band = items.slice(bandStart, bandEnd);
            for (let i = band.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [band[i], band[j]] = [band[j], band[i]];
            }
            result.push(...band);
            bandStart = bandEnd;
        }

        return result;
    }

    /**
     * Get mixed feed with all content types — YouTube-like algorithm
     * Shorts are prioritized heavily on first page (like YouTube Shorts shelf).
     * Subsequent pages focus on long-form video with occasional shorts injected.
     */
    async getMixedFeed(userId, options = {}) {
        const { page = 1, limit = 20 } = options;
        const isFirstPage = page === 1;

        // YouTube-like distribution: shorts dominate first page
        const shortsLimit = isFirstPage ? 15 : 4;
        const videoLimit = isFirstPage ? limit : limit;
        const audioLimit = isFirstPage ? 8 : 3;
        const postsLimit = isFirstPage ? 6 : 2;

        // Fetch content for each type in parallel
        const [shorts, videos, audio, posts] = await Promise.all([
            this.getRecommendations(userId, 'short', { page: 1, limit: shortsLimit }),
            this.getRecommendations(userId, 'video', { page, limit: videoLimit }),
            this.getRecommendations(userId, 'audio', { page: 1, limit: audioLimit }),
            this.getRecommendations(userId, 'post', { page: 1, limit: postsLimit })
        ]);

        return {
            shorts: shorts.content,
            videos: videos.content,
            audio: audio.content,
            posts: posts.content,
            pagination: videos.pagination
        };
    }
}

// Singleton instance
export const watchHistoryEngine = new WatchHistoryRecommendationEngine();
