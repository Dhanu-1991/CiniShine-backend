// algorithms/videoSimilarity.js

/**
 * Video similarity and recommendation algorithms
 */

import Video from '../models/video.model.js';

/**
 * Find similar videos based on content analysis
 * @param {Object} currentVideo - The video to find recommendations for
 * @param {number} page - Page number for pagination
 * @param {number} limit - Number of videos per page
 * @returns {Object} { videos, hasNextPage, totalPages }
 */
export const findSimilarVideos = async (currentVideo, page = 1, limit = 10) => {
    try {
        // Extract keywords from current video
        const keywords = extractKeywords(currentVideo);

        // Find all completed videos except current one
        const allVideos = await Video.find({
            status: 'completed',
            _id: { $ne: currentVideo._id }
        }).populate('userId', 'userName');

        // Calculate similarity scores
        const scoredVideos = allVideos.map(video => ({
            ...video.toObject(),
            similarityScore: calculateSimilarityScore(currentVideo, video, keywords)
        }));

        // Sort by similarity score descending
        scoredVideos.sort((a, b) => b.similarityScore - a.similarityScore);

        // Apply pagination
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedVideos = scoredVideos.slice(startIndex, endIndex);

        // Generate thumbnail URLs
        const videosWithUrls = await Promise.all(
            paginatedVideos.map(async (video) => {
                let thumbnailUrl = null;
                if (video.thumbnailKey) {
                    try {
                        // Import s3Client here or pass it
                        const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
                        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');

                        const s3Client = new S3Client({
                            region: process.env.AWS_REGION,
                            credentials: {
                                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                            },
                        });

                        thumbnailUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: video.thumbnailKey,
                            }),
                            { expiresIn: 3600 }
                        );
                    } catch (error) {
                        console.error('Error generating thumbnail URL:', error);
                    }
                }

                return {
                    _id: video._id,
                    title: video.title,
                    description: video.description,
                    duration: video.duration,
                    thumbnailUrl,
                    views: video.views,
                    createdAt: video.createdAt,
                    user: video.userId,
                    similarityScore: video.similarityScore
                };
            })
        );

        const totalVideos = scoredVideos.length;
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
 * Extract keywords from video title and description
 * @param {Object} video - Video object
 * @returns {Array} Array of keywords
 */
const extractKeywords = (video) => {
    const text = `${video.title} ${video.description || ''}`.toLowerCase();

    // Remove common stop words and split
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those'];

    const words = text
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.includes(word));

    // Return unique keywords
    return [...new Set(words)];
};

/**
 * Calculate similarity score between two videos
 * @param {Object} video1 - First video
 * @param {Object} video2 - Second video
 * @param {Array} keywords1 - Keywords from first video
 * @returns {number} Similarity score (0-1)
 */
const calculateSimilarityScore = (video1, video2, keywords1) => {
    let score = 0;

    // Keyword overlap (40% weight)
    const keywords2 = extractKeywords(video2);
    const commonKeywords = keywords1.filter(keyword => keywords2.includes(keyword));
    const keywordSimilarity = commonKeywords.length / Math.max(keywords1.length, keywords2.length);
    score += keywordSimilarity * 0.4;

    // User similarity (if same creator, boost slightly) (20% weight)
    const userSimilarity = video1.userId.toString() === video2.userId.toString() ? 1 : 0;
    score += userSimilarity * 0.2;

    // View popularity (normalize and weight) (20% weight)
    const maxViews = 10000; // Assume max views for normalization
    const popularityScore = Math.min(video2.views / maxViews, 1);
    score += popularityScore * 0.2;

    // Recency (newer videos get slight boost) (10% weight)
    const daysSinceCreation = (new Date() - new Date(video2.createdAt)) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - daysSinceCreation / 365); // Boost videos from last year
    score += recencyScore * 0.1;

    // Duration similarity (10% weight) - similar length videos
    const durationDiff = Math.abs(video1.duration - video2.duration);
    const durationSimilarity = Math.max(0, 1 - durationDiff / Math.max(video1.duration, video2.duration));
    score += durationSimilarity * 0.1;

    return Math.min(score, 1);
};