import Video from "../../models/video.model.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Advanced search algorithm for videos
 * Searches by title, description, and user name
 * Ranks results by relevance score
 */
export const searchVideos = async (req, res) => {
    try {
        const { q: query, page = 1, limit = 20 } = req.query;

        if (!query || query.trim().length < 2) {
            return res.json({
                videos: [],
                pagination: {
                    currentPage: 1,
                    totalPages: 0,
                    totalVideos: 0,
                    hasNextPage: false
                }
            });
        }

        const searchTerm = query.trim().toLowerCase();
        const skip = (page - 1) * limit;

        // Get all completed videos with user info
        const allVideos = await Video.find({ status: 'completed' })
            .populate('userId', 'userName channelName')
            .sort({ createdAt: -1 });

        // Score and filter videos based on search relevance
        const scoredVideos = allVideos.map(video => {
            const title = video.title?.toLowerCase() || '';
            const description = video.description?.toLowerCase() || '';
            const userName = video.userId?.userName?.toLowerCase() || '';
            const channelName = video.userId?.channelName?.toLowerCase() || '';

            let score = 0;

            // Exact matches get highest score
            if (title === searchTerm) score += 100;
            if (channelName === searchTerm) score += 90;
            if (userName === searchTerm) score += 80;

            // Word matches in title
            const titleWords = title.split(/\s+/);
            if (titleWords.includes(searchTerm)) score += 50;

            // Partial matches in title
            if (title.includes(searchTerm)) score += 30;

            // Matches in description
            if (description.includes(searchTerm)) score += 20;

            // Matches in channel name
            if (channelName.includes(searchTerm)) score += 25;

            // Matches in username
            if (userName.includes(searchTerm)) score += 15;

            // Boost recent videos
            const daysSinceCreation = (new Date() - new Date(video.createdAt)) / (1000 * 60 * 60 * 24);
            const recencyBoost = Math.max(0, 30 - daysSinceCreation); // Boost videos from last 30 days
            score += recencyBoost;

            // Boost popular videos
            const popularityBoost = Math.min(video.views / 1000, 20); // Max 20 points for popular videos
            score += popularityBoost;

            return {
                ...video.toObject(),
                searchScore: score
            };
        }).filter(video => video.searchScore > 0) // Only include videos with some relevance
            .sort((a, b) => b.searchScore - a.searchScore); // Sort by relevance

        // Apply pagination
        const paginatedVideos = scoredVideos.slice(skip, skip + limit);

        // Generate thumbnail URLs
        const videosWithUrls = await Promise.all(
            paginatedVideos.map(async (video) => {
                let thumbnailUrl = null;
                if (video.thumbnailKey) {
                    try {
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
                    likes: video.likes || 0,
                    dislikes: video.dislikes || 0,
                    createdAt: video.createdAt,
                    user: {
                        _id: video.userId._id,
                        userName: video.userId.userName,
                        channelName: video.userId.channelName
                    },
                    searchScore: video.searchScore
                };
            })
        );

        const totalVideos = scoredVideos.length;
        const hasNextPage = skip + limit < totalVideos;

        res.json({
            videos: videosWithUrls,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalVideos / limit),
                totalVideos,
                hasNextPage,
                limit: parseInt(limit)
            },
            searchTerm: query
        });

    } catch (error) {
        console.error('Error searching videos:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};