// algorithms/watchHistoryRecommendation.js

import mongoose from 'mongoose';
import WatchHistory from '../models/watchHistory.model.js';
import Video from '../models/video.model.js';
import Content from '../models/content.model.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
    if (!key) return null;
    try {
        return await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: key,
            }),
            { expiresIn: 3600 }
        );
    } catch (error) {
        console.error('Error generating signed URL:', error);
        return null;
    }
};

/**
 * WatchHistoryRecommendationEngine
 * Analyzes user's watch history to provide personalized recommendations
 */
export class WatchHistoryRecommendationEngine {
    constructor() {
        this.weights = {
            // Content similarity weights
            tagMatch: 0.25,
            categoryMatch: 0.15,
            creatorMatch: 0.20,

            // Engagement weights  
            watchTimeWeight: 0.15,
            completionWeight: 0.10,
            interactionWeight: 0.15
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
     * Score a content item against user profile
     */
    scoreContent(content, userProfile, watchedIds) {
        // Skip already watched
        if (watchedIds.has(content._id.toString())) {
            return -1;
        }

        let score = 0;

        // Tag matching
        const contentTags = content.tags || [];
        for (const tag of contentTags) {
            if (userProfile.preferredTags[tag]) {
                score += userProfile.preferredTags[tag] * this.weights.tagMatch;
            }
        }

        // Category matching
        if (content.category && userProfile.preferredCategories[content.category]) {
            score += userProfile.preferredCategories[content.category] * this.weights.categoryMatch;
        }

        // Creator matching
        const creatorId = (content.userId?._id || content.userId)?.toString();
        if (creatorId && userProfile.preferredCreators[creatorId]) {
            score += userProfile.preferredCreators[creatorId] * this.weights.creatorMatch;
        }

        // Popularity boost (normalized)
        const popularityScore = Math.min((content.views || 0) / 10000, 1);
        score += popularityScore * 0.1;

        // Recency boost
        const daysSinceCreation = (Date.now() - new Date(content.createdAt)) / (1000 * 60 * 60 * 24);
        const recencyScore = Math.exp(-daysSinceCreation / 30);
        score += recencyScore * 0.1;

        // Random factor for diversity
        score += Math.random() * 0.05;

        return score;
    }

    /**
     * Get personalized recommendations for a specific content type
     */
    async getRecommendations(userId, contentType, options = {}) {
        const { page = 1, limit = 10, excludeIds = [] } = options;

        // Build user profile
        const userProfile = await this.buildUserProfile(userId);

        // Get watched content IDs
        const watchedHistory = await WatchHistory.find({ userId, contentType })
            .select('contentId')
            .lean();
        const watchedIds = new Set([
            ...watchedHistory.map(h => h.contentId.toString()),
            ...excludeIds.map(id => id.toString())
        ]);

        let candidates = [];

        if (contentType === 'video') {
            candidates = await Video.find({
                status: 'completed',
                _id: { $nin: Array.from(watchedIds) }
            })
                .populate('userId', 'userName channelName channelPicture')
                .lean();
        } else {
            candidates = await Content.find({
                contentType,
                status: 'completed',
                visibility: 'public',
                _id: { $nin: Array.from(watchedIds) }
            })
                .populate('userId', 'userName channelName channelPicture')
                .lean();
        }

        // Score and sort
        let scoredContent;
        if (userProfile) {
            scoredContent = candidates.map(content => ({
                ...content,
                recommendationScore: this.scoreContent(content, userProfile, watchedIds)
            })).filter(c => c.recommendationScore >= 0);

            scoredContent.sort((a, b) => b.recommendationScore - a.recommendationScore);
        } else {
            // No history - fallback to popularity + recency
            scoredContent = candidates.map(content => ({
                ...content,
                recommendationScore: this.fallbackScore(content)
            }));
            scoredContent.sort((a, b) => b.recommendationScore - a.recommendationScore);
        }

        // Paginate
        const startIdx = (page - 1) * limit;
        const paginatedContent = scoredContent.slice(startIdx, startIdx + limit);

        // Generate URLs
        const contentWithUrls = await Promise.all(
            paginatedContent.map(async (content) => ({
                _id: content._id,
                contentType: contentType,
                title: content.title,
                description: content.description,
                duration: content.duration,
                thumbnailUrl: await generateSignedUrl(content.thumbnailKey),
                imageUrl: content.imageKey ? await generateSignedUrl(content.imageKey) : null,
                views: content.views,
                likeCount: content.likeCount || content.likes?.length || 0,
                createdAt: content.createdAt,
                channelName: content.channelName || content.userId?.channelName || content.userId?.userName || 'Unknown',
                channelPicture: content.userId?.channelPicture || null,
                status: content.status,
                // Audio specific
                artist: content.artist,
                album: content.album,
                audioCategory: content.audioCategory,
                // Post specific
                postContent: content.postContent,
                recommendationScore: content.recommendationScore
            }))
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
     * Fallback scoring for users without watch history
     */
    fallbackScore(content) {
        let score = 0;

        // Popularity
        score += Math.min((content.views || 0) / 10000, 1) * 0.4;

        // Recency
        const daysSinceCreation = (Date.now() - new Date(content.createdAt)) / (1000 * 60 * 60 * 24);
        score += Math.exp(-daysSinceCreation / 14) * 0.4;

        // Engagement rate
        const engagementRate = (content.likeCount || 0) / Math.max(content.views || 1, 1);
        score += Math.min(engagementRate * 10, 1) * 0.15;

        // Random for diversity
        score += Math.random() * 0.05;

        return score;
    }

    /**
     * Get mixed feed with all content types (shorts first, then videos, audio, posts)
     */
    async getMixedFeed(userId, options = {}) {
        const { page = 1, limit = 20, shortsLimit = 10, audioLimit = 6, postsLimit = 4 } = options;
        const isFirstPage = page === 1;

        // Fetch content for each type in parallel
        const [shorts, videos, audio, posts] = await Promise.all([
            isFirstPage ? this.getRecommendations(userId, 'short', { page: 1, limit: shortsLimit }) : { content: [] },
            this.getRecommendations(userId, 'video', { page, limit }),
            isFirstPage ? this.getRecommendations(userId, 'audio', { page: 1, limit: audioLimit }) : { content: [] },
            isFirstPage ? this.getRecommendations(userId, 'post', { page: 1, limit: postsLimit }) : { content: [] }
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
