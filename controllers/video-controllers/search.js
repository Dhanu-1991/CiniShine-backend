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
 * Extract hashtags from text
 * @param {string} text - Text to extract hashtags from
 * @returns {string[]} Array of hashtags (without #)
 */
const extractHashtags = (text) => {
    if (!text) return [];
    const matches = text.match(/#(\w+)/g) || [];
    return matches.map(tag => tag.substring(1).toLowerCase());
};

/**
 * Calculate relevance score between search terms and text
 * @param {string[]} searchWords - Array of search words
 * @param {string} text - Text to search in
 * @param {number} exactMatchScore - Score for exact full match
 * @param {number} wordMatchScore - Score for each word match
 * @param {number} partialMatchScore - Score for partial match
 */
const calculateTextScore = (searchWords, text, exactMatchScore, wordMatchScore, partialMatchScore) => {
    if (!text) return 0;

    const textLower = text.toLowerCase();
    const textWords = textLower.split(/\s+/).filter(w => w.length > 0);
    let score = 0;

    // Check for exact full phrase match
    const fullSearchPhrase = searchWords.join(' ');
    if (textLower === fullSearchPhrase) {
        score += exactMatchScore;
    }

    // Check for each search word
    searchWords.forEach(searchWord => {
        // Exact word match (highest for individual words)
        if (textWords.includes(searchWord)) {
            score += wordMatchScore;
        }
        // Word starts with search term
        else if (textWords.some(tw => tw.startsWith(searchWord))) {
            score += wordMatchScore * 0.7;
        }
        // Partial/substring match
        else if (textLower.includes(searchWord)) {
            score += partialMatchScore;
        }
    });

    return score;
};

/**
 * Calculate hashtag match score
 * @param {string[]} searchHashtags - Hashtags from search query
 * @param {string[]} contentHashtags - Hashtags from video content
 * @returns {number} Score based on hashtag matches
 */
const calculateHashtagScore = (searchHashtags, contentHashtags) => {
    if (searchHashtags.length === 0 || contentHashtags.length === 0) return 0;

    let score = 0;
    searchHashtags.forEach(searchTag => {
        // Exact hashtag match
        if (contentHashtags.includes(searchTag)) {
            score += 60; // High score for exact hashtag match
        }
        // Partial hashtag match
        else if (contentHashtags.some(tag => tag.includes(searchTag) || searchTag.includes(tag))) {
            score += 30;
        }
    });

    return score;
};

/**
 * Advanced search algorithm for videos
 * Searches by title, description, channel name, username, and hashtags
 * Ranks results by relevance score with smart word matching
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

        // Extract hashtags from search query (e.g., "#music #viral")
        const searchHashtags = extractHashtags(query);

        // Remove hashtags from search term for regular word matching
        const cleanSearchTerm = searchTerm.replace(/#\w+/g, '').trim();
        const searchWords = cleanSearchTerm.split(/\s+/).filter(w => w.length > 0);

        const skip = (page - 1) * parseInt(limit);

        // Get all completed videos with user info
        const allVideos = await Video.find({ status: 'completed' })
            .populate('userId', 'userName channelName channelPicture')
            .sort({ createdAt: -1 });

        // Score and filter videos based on search relevance
        const scoredVideos = allVideos.map(video => {
            const title = video.title || '';
            const description = video.description || '';
            const userName = video.userId?.userName || '';
            const channelName = video.userId?.channelName || '';

            // Extract hashtags from video title and description
            const titleHashtags = extractHashtags(title);
            const descriptionHashtags = extractHashtags(description);
            const allVideoHashtags = [...new Set([...titleHashtags, ...descriptionHashtags])];

            let score = 0;

            // === HASHTAG MATCHING (highest priority when searching with #) ===
            if (searchHashtags.length > 0) {
                score += calculateHashtagScore(searchHashtags, allVideoHashtags);
            }

            // === REGULAR WORD MATCHING ===
            if (searchWords.length > 0) {
                // Title scoring (highest priority)
                // Exact match: 100, word match: 50 each, partial: 30
                score += calculateTextScore(searchWords, title, 100, 50, 30);

                // Channel name scoring (high priority)
                // Exact match: 90, word match: 40 each, partial: 25
                score += calculateTextScore(searchWords, channelName, 90, 40, 25);

                // Username scoring (medium priority)
                // Exact match: 80, word match: 30 each, partial: 20
                score += calculateTextScore(searchWords, userName, 80, 30, 20);

                // Description scoring (lower priority)
                // Exact match: 40, word match: 15 each, partial: 10
                score += calculateTextScore(searchWords, description, 40, 15, 10);

                // Bonus for matching multiple search words (relevance boost)
                const matchedWordsInTitle = searchWords.filter(sw =>
                    title.toLowerCase().includes(sw)
                ).length;
                if (matchedWordsInTitle > 1) {
                    score += matchedWordsInTitle * 10; // Bonus for multi-word matches
                }
            }

            // === CHANNEL NAME BOOST ===
            // Extra boost if channel name matches closely
            const channelNameLower = channelName.toLowerCase();
            const searchWordsForChannel = searchHashtags.length > 0
                ? [...searchWords, ...searchHashtags]
                : searchWords;

            searchWordsForChannel.forEach(word => {
                if (channelNameLower === word) {
                    score += 70; // Exact channel name match
                } else if (channelNameLower.startsWith(word) || channelNameLower.endsWith(word)) {
                    score += 35; // Channel name starts/ends with search
                }
            });

            // Recency boost (videos from last 30 days get up to 20 points)
            const daysSinceCreation = (new Date() - new Date(video.createdAt)) / (1000 * 60 * 60 * 24);
            const recencyBoost = Math.max(0, 20 - (daysSinceCreation * 0.66));
            score += recencyBoost;

            // Popularity boost (up to 15 points based on views)
            const popularityBoost = Math.min(video.views / 1000, 15);
            score += popularityBoost;

            return {
                ...video.toObject(),
                searchScore: score,
                matchedHashtags: allVideoHashtags.filter(tag =>
                    searchHashtags.some(st => tag.includes(st) || st.includes(tag))
                )
            };
        }).filter(video => video.searchScore > 0) // Only include videos with some relevance
            .sort((a, b) => b.searchScore - a.searchScore); // Sort by relevance

        // Apply pagination
        const paginatedVideos = scoredVideos.slice(skip, skip + parseInt(limit));

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
                        _id: video.userId?._id,
                        userName: video.userId?.userName,
                        channelName: video.userId?.channelName,
                        channelPicture: video.userId?.channelPicture
                    },
                    searchScore: video.searchScore,
                    matchedHashtags: video.matchedHashtags || []
                };
            })
        );

        const totalVideos = scoredVideos.length;
        const hasNextPage = skip + parseInt(limit) < totalVideos;

        res.json({
            videos: videosWithUrls,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalVideos / parseInt(limit)),
                totalVideos,
                hasNextPage,
                limit: parseInt(limit)
            },
            searchTerm: query,
            searchHashtags,
            searchWords
        });

    } catch (error) {
        console.error('Error searching videos:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};