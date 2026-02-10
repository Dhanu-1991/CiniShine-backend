// algorithms/recommendationAlgorithm.js

/**
 * High-level recommendation algorithm inspired by YouTube's approach
 * Uses collaborative filtering, content-based filtering, and popularity metrics
 */

export class RecommendationEngine {
    constructor() {
        this.weights = {
            popularity: 0.25,
            userSimilarity: 0.25,
            contentSimilarity: 0.15,
            recency: 0.1,
            engagement: 0.15,
            watchTime: 0.1
        };
        this.contentWeights = {
            popularity: 0.3,
            userSimilarity: 0.2,
            contentSimilarity: 0.1,
            recency: 0.15,
            engagement: 0.2,
            watchTime: 0.05
        };
    }

    /**
     * Main recommendation method
     * @param {Object} user - Current user object
     * @param {Array} allVideos - All available videos
     * @param {Array} userVideos - User's own videos (to exclude)
     * @param {Object} options - Additional options like limit, page
     * @returns {Array} Recommended videos sorted by score
     */
    async getRecommendations(user, allVideos, userVideos, options = {}) {
        const { limit = 10, excludeOwn = true } = options;

        // Filter out user's own videos if requested
        const userId = user?._id?.toString();
        let candidateVideos = excludeOwn && userId
            ? allVideos.filter(video => video.userId?.toString() !== userId)
            : allVideos;

        // Calculate scores for each video
        const scoredVideos = candidateVideos.map(video => ({
            ...(typeof video?.toJSON === 'function' ? video.toJSON() : video),
            recommendationScore: this.calculateRecommendationScore(user, video, allVideos)
        }));

        // Sort by score descending
        scoredVideos.sort((a, b) => b.recommendationScore - a.recommendationScore);

        // Return top recommendations
        return scoredVideos.slice(0, limit);
    }

    /**
     * Calculate recommendation score for a video
     * @param {Object} user - Current user
     * @param {Object} video - Video to score
     * @param {Array} allVideos - All videos for context
     * @returns {number} Recommendation score
     */
    calculateRecommendationScore(user, video, allVideos) {
        let score = 0;

        // Popularity score (normalized views)
        const maxViews = Math.max(...allVideos.map(v => v.views || 0));
        const popularityScore = maxViews > 0 ? (video.views || 0) / maxViews : 0;
        score += popularityScore * this.weights.popularity;

        // User similarity score (based on roles)
        const userSimilarityScore = this.calculateUserSimilarity(user, video.userId, allVideos);
        score += userSimilarityScore * this.weights.userSimilarity;

        // Content similarity score (based on video metadata)
        const contentSimilarityScore = this.calculateContentSimilarity(user, video);
        score += contentSimilarityScore * this.weights.contentSimilarity;

        // Recency score (newer videos get slight boost)
        const recencyScore = this.calculateRecencyScore(video.createdAt);
        score += recencyScore * this.weights.recency;

        // Engagement score (likes vs views)
        const engagementScore = this.calculateEngagementScore(video);
        score += engagementScore * this.weights.engagement;

        // Watch time score (avg watch time vs duration)
        const watchTimeScore = this.calculateWatchTimeScore(video);
        score += watchTimeScore * this.weights.watchTime;

        return score;
    }

    /**
     * Calculate user similarity based on roles and content patterns
     * @param {Object} user - Current user
     * @param {ObjectId} videoUserId - Video owner's ID
     * @param {Array} allVideos - All videos
     * @returns {number} Similarity score (0-1)
     */
    calculateUserSimilarity(user, videoUserId, allVideos) {
        if (!user.roles || user.roles.length === 0) return 0.5; // Neutral score

        const targetUserId = videoUserId?._id ? videoUserId._id.toString() : videoUserId?.toString();
        if (!targetUserId) return 0.5;

        // Find videos by the same user
        const userVideos = allVideos.filter(v => {
            const vidUserId = v.userId?._id ? v.userId._id.toString() : v.userId?.toString();
            return vidUserId === targetUserId;
        });

        if (userVideos.length === 0) return 0.5;

        // Calculate role overlap
        const videoUserRoles = userVideos[0].userId.roles || []; // Assuming roles are populated
        const commonRoles = user.roles.filter(role => videoUserRoles.includes(role));

        return commonRoles.length / Math.max(user.roles.length, videoUserRoles.length);
    }

    /**
     * Calculate content similarity based on video attributes
     * @param {Object} user - Current user
     * @param {Object} video - Video object
     * @returns {number} Similarity score (0-1)
     */
    calculateContentSimilarity(user, video) {
        // This is a simplified version - in production, you'd use NLP for description similarity
        // For now, we'll use basic heuristics

        let similarity = 0;

        // If user has preferred rendition, boost videos with similar quality
        if (user.prefferedRendition && user.prefferedRendition !== 'Auto') {
            const preferredQuality = user.prefferedRendition.replace('p', '');
            const videoQualities = video.renditions?.map(r => r.resolution?.replace('p', '')) || [];
            if (videoQualities.includes(preferredQuality)) {
                similarity += 0.3;
            }
        }

        // Boost videos from users with similar roles (already handled in user similarity)

        // Add some randomness to prevent same recommendations
        similarity += Math.random() * 0.1;

        return Math.min(similarity, 1);
    }

    /**
     * Calculate engagement score (likes vs views)
     * @param {Object} item - Video or content
     * @returns {number} Engagement score (0-1)
     */
    calculateEngagementScore(item) {
        const likes = item.likeCount ?? (Array.isArray(item.likes) ? item.likes.length : 0);
        const views = item.views || 0;
        const engagement = likes / Math.max(views, 1);
        return Math.min(engagement * 10, 1);
    }

    /**
     * Calculate watch time score (avg watch time vs duration)
     * @param {Object} item - Video or content
     * @returns {number} Watch time score (0-1)
     */
    calculateWatchTimeScore(item) {
        const avgWatchTime = item.averageWatchTime || 0;
        const duration = item.duration || 0;
        if (!avgWatchTime || !duration) return 0;
        return Math.min(avgWatchTime / duration, 1);
    }

    /**
     * Calculate recency score - newer videos get slight preference
     * @param {Date} createdAt - Video creation date
     * @returns {number} Recency score (0-1)
     */
    calculateRecencyScore(createdAt) {
        const now = new Date();
        const daysSinceCreation = (now - new Date(createdAt)) / (1000 * 60 * 60 * 24);

        // Exponential decay: videos from last 30 days get boost
        if (daysSinceCreation <= 30) {
            return Math.exp(-daysSinceCreation / 30);
        }

        return 0.1; // Small baseline for older videos
    }

    /**
     * Get trending videos (high view velocity)
     * @param {Array} videos - All videos
     * @param {number} limit - Number to return
     * @returns {Array} Trending videos
     */
    getTrendingVideos(videos, limit = 10) {
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        return videos
            .filter(video => new Date(video.createdAt) >= weekAgo)
            .sort((a, b) => (b.views || 0) - (a.views || 0))
            .slice(0, limit);
    }

    /**
     * Get videos from similar creators
     * @param {Object} user - Current user
     * @param {Array} videos - All videos
     * @param {number} limit - Number to return
     * @returns {Array} Videos from similar creators
     */
    getSimilarCreatorVideos(user, videos, limit = 10) {
        if (!user.roles || user.roles.length === 0) {
            return this.getTrendingVideos(videos, limit);
        }

        const similarVideos = videos.filter(video => {
            // This would need user data populated - simplified version
            return video.userId && video.userId.toString() !== user._id.toString();
        });

        return similarVideos.slice(0, limit);
    }

    /**
     * Content recommendations for shorts/audio/posts
     * @param {Object} user - Current user object
     * @param {Array} allContent - All available content items
     * @param {Object} options - Additional options like limit, page
     * @returns {Array} Recommended content sorted by score
     */
    async getContentRecommendations(user, allContent, options = {}) {
        const { limit = 10, excludeOwn = true } = options;

        const userId = user?._id?.toString();
        let candidateContent = excludeOwn && userId
            ? allContent.filter(item => item.userId?.toString() !== userId)
            : allContent;

        const scoredContent = candidateContent.map(item => ({
            ...item,
            recommendationScore: this.calculateContentRecommendationScore(user, item, allContent)
        }));

        scoredContent.sort((a, b) => b.recommendationScore - a.recommendationScore);

        return scoredContent.slice(0, limit);
    }

    /**
     * Calculate recommendation score for shorts/audio/posts
     * @param {Object} user - Current user
     * @param {Object} item - Content item
     * @param {Array} allContent - All content for context
     * @returns {number} Recommendation score (0-1)
     */
    calculateContentRecommendationScore(user, item, allContent) {
        let score = 0;

        const maxViews = Math.max(...allContent.map(c => c.views || 0));
        const popularityScore = maxViews > 0 ? (item.views || 0) / maxViews : 0;
        score += popularityScore * this.contentWeights.popularity;

        const userSimilarityScore = this.calculateUserSimilarity(user || {}, item.userId, allContent);
        score += userSimilarityScore * this.contentWeights.userSimilarity;

        // Content similarity for shorts/audio/posts is currently tag-based if available
        let contentSimilarityScore = 0.5;
        if (user?.preferredTags?.length && item.tags?.length) {
            const commonTags = item.tags.filter(tag => user.preferredTags.includes(tag));
            contentSimilarityScore = commonTags.length / Math.max(item.tags.length, user.preferredTags.length);
        }
        score += contentSimilarityScore * this.contentWeights.contentSimilarity;

        const recencyScore = this.calculateRecencyScore(item.createdAt);
        score += recencyScore * this.contentWeights.recency;

        const engagementScore = this.calculateEngagementScore(item);
        score += engagementScore * this.contentWeights.engagement;

        const watchTimeScore = this.calculateWatchTimeScore(item);
        score += watchTimeScore * this.contentWeights.watchTime;

        return score;
    }
}

// Export singleton instance
export const recommendationEngine = new RecommendationEngine();