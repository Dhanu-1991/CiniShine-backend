import Content from "../../models/content.model.js";
import User from "../../models/user.model.js";
import SearchHistory from "../../models/searchHistory.model.js";
import { getCfUrl } from "../../config/cloudfront.js";

/**
 * Get search text suggestions (autocomplete)
 * Returns popular/recent search queries, NOT videos
 */
export const getSearchSuggestions = async (req, res) => {
    try {
        const { q: query } = req.query;
        const userId = req.user?.id;

        if (!query || query.trim().length < 1) {
            // Return recent searches if no query
            if (userId) {
                const recentSearches = await SearchHistory.getRecentSearches(userId, 8);
                return res.json({
                    suggestions: recentSearches.map(s => ({ query: s.query, type: 'recent' })),
                    type: 'recent'
                });
            }
            // Return trending searches for anonymous users
            const trending = await SearchHistory.getTrendingSearches(8);
            return res.json({
                suggestions: trending.map(s => ({ query: s.query, type: 'trending' })),
                type: 'trending'
            });
        }

        // Get search suggestions based on partial query
        const suggestions = await SearchHistory.getSuggestions(query.trim(), userId, 10);

        res.json({
            suggestions,
            type: 'suggestions'
        });
    } catch (error) {
        console.error('Error getting search suggestions:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * Clear user's search history
 */
export const clearSearchHistory = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        await SearchHistory.clearUserHistory(userId);
        res.json({ success: true, message: 'Search history cleared' });
    } catch (error) {
        console.error('Error clearing search history:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

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
        const userId = req.user?.id;

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

        // Use MongoDB text search with indexes for faster initial filtering
        // Build query with $or for multiple field matching
        const searchRegex = new RegExp(searchWords.join('|'), 'i');

        const matchQuery = {
            status: 'completed',
            visibility: 'public',
            $or: [
                { title: searchRegex },
                { description: searchRegex }
            ]
        };

        // Get matching videos with user info (limited initial fetch for performance)
        const allVideos = await Content.find({ ...matchQuery, contentType: 'video' })
            .populate('userId', 'userName channelName channelHandle channelPicture')
            .sort({ views: -1, createdAt: -1 })
            .limit(200) // Limit to top 200 for scoring (performance optimization)
            .sort({ createdAt: -1 });

        // Score and filter videos based on search relevance
        const scoredVideos = allVideos.map(video => {
            const title = video.title || '';
            const description = video.description || '';
            const userName = video.userId?.userName || '';
            const channelName = video.userId?.channelName || '';
            const channelHandle = video.userId?.channelHandle || '';

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

                // Channel handle scoring (high priority)
                score += calculateTextScore(searchWords, channelHandle, 85, 35, 20);

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

        // Generate CloudFront thumbnail URLs
        const videosWithUrls = paginatedVideos.map((video) => {
            const thumbnailUrl = getCfUrl(video.thumbnailKey);

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
                    channelHandle: video.userId?.channelHandle,
                    channelPicture: video.userId?.channelPicture
                },
                searchScore: video.searchScore,
                matchedHashtags: video.matchedHashtags || []
            };
        });

        const totalVideos = scoredVideos.length;
        const hasNextPage = skip + parseInt(limit) < totalVideos;

        // Record search query for suggestions (async, don't wait)
        SearchHistory.recordSearch(userId, query.trim(), totalVideos).catch(err =>
            console.error('Error recording search:', err)
        );

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

/**
 * Unified search across ALL content types + channels
 * GET /api/v2/video/search/unified?q=...&type=all|video|audio|short|post|channel&page=1&limit=20
 *
 * Returns:
 *   { videos, audio, shorts, posts, channels, totalCount, query }
 *   or when type != 'all': { results: [...], pagination, totalCount, query }
 */
export const unifiedSearch = async (req, res) => {
    try {
        const { q: query, type = 'all', page = 1, limit = 20 } = req.query;
        const userId = req.user?.id;

        if (!query || query.trim().length < 1) {
            return res.json({ videos: [], audio: [], shorts: [], posts: [], channels: [], totalCount: 0, query: '' });
        }

        const searchTerm = query.trim().toLowerCase();
        const searchHashtags = extractHashtags(query);
        const cleanSearchTerm = searchTerm.replace(/#\w+/g, '').trim();
        const searchWords = cleanSearchTerm.split(/\s+/).filter(w => w.length > 1);

        if (searchWords.length === 0 && searchHashtags.length === 0) {
            return res.json({ videos: [], audio: [], shorts: [], posts: [], channels: [], totalCount: 0, query });
        }

        const searchRegex = searchWords.length > 0
            ? new RegExp(searchWords.join('|'), 'i')
            : null;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // ── Helper: score a content item ────────────────────────────────────
        const scoreItem = (item) => {
            const title = item.title || '';
            const description = item.description || '';
            const channelName = item.userId?.channelName || '';
            const channelHandle = item.userId?.channelHandle || '';
            const userName = item.userId?.userName || '';
            const tags = item.tags || [];
            const titleHashtags = extractHashtags(title);
            const descHashtags = extractHashtags(description);
            const allHashtags = [...new Set([...titleHashtags, ...descHashtags, ...tags])];
            let score = 0;

            if (searchHashtags.length > 0) score += calculateHashtagScore(searchHashtags, allHashtags);
            if (searchWords.length > 0) {
                score += calculateTextScore(searchWords, title, 100, 50, 30);
                score += calculateTextScore(searchWords, channelName, 80, 35, 20);
                score += calculateTextScore(searchWords, channelHandle, 75, 30, 18);
                score += calculateTextScore(searchWords, userName, 65, 25, 15);
                score += calculateTextScore(searchWords, description, 35, 12, 8);
                tags.forEach(tag => score += calculateTextScore(searchWords, tag, 50, 30, 15));
                const multiWordBonus = searchWords.filter(sw => title.toLowerCase().includes(sw)).length;
                if (multiWordBonus > 1) score += multiWordBonus * 8;
            }
            // Recency and popularity boosts
            const daysSince = (Date.now() - new Date(item.createdAt)) / 86400000;
            score += Math.max(0, 15 - daysSince * 0.5);
            score += Math.min((item.views || 0) / 1000, 12);
            return score;
        };

        // ── Helper: score a channel (User doc) ───────────────────────────────
        const scoreChannel = (user) => {
            const channelName = user.channelName || '';
            const channelHandle = user.channelHandle || '';
            const userName = user.userName || '';
            const bio = user.channelDescription || user.bio || '';
            let score = 0;
            if (searchWords.length > 0) {
                score += calculateTextScore(searchWords, channelName, 120, 60, 35);
                score += calculateTextScore(searchWords, channelHandle, 110, 55, 30);
                score += calculateTextScore(searchWords, userName, 90, 40, 25);
                score += calculateTextScore(searchWords, bio, 30, 10, 5);
            }
            // sub count boost
            const subs = (user.subscriptions?.length || 0);
            score += Math.min(subs / 100, 15);
            return score;
        };

        // ── Build parallel queries based on requested type ────────────────────
        const wantAll = type === 'all';
        const contentTypes = [];
        if (wantAll || type === 'video') contentTypes.push('video');
        if (wantAll || type === 'audio') contentTypes.push('audio');
        if (wantAll || type === 'short') contentTypes.push('short');
        if (wantAll || type === 'post') contentTypes.push('post');
        const wantChannels = wantAll || type === 'channel';

        // Build mongo filter for content — exclude uploading/processing items
        const contentFilter = {
            visibility: 'public',
            status: { $nin: ['uploading', 'processing'] },
            ...(searchRegex ? { $or: [{ title: searchRegex }, { description: searchRegex }, { tags: searchRegex }] } : {}),
        };

        // Build parallel fetches
        const queries = [];
        if (contentTypes.length > 0) {
            // Fetch all needed content types in one query, then split
            queries.push(
                Content.find({ ...contentFilter, contentType: { $in: contentTypes } })
                    .populate('userId', 'userName channelName channelHandle channelPicture subscriptions')
                    .sort({ createdAt: -1 })
                    .limit(300)
                    .lean()
            );
        } else {
            queries.push(Promise.resolve([]));
        }

        if (wantChannels) {
            const channelRegex = new RegExp(searchWords.join('|') || searchTerm, 'i');
            queries.push(
                User.find({
                    channelName: { $exists: true, $ne: '' },
                    channelHandle: { $exists: true, $ne: '' },
                    $or: [
                        { channelName: channelRegex },
                        { channelHandle: channelRegex },
                    ],
                })
                    .select('userName channelName channelHandle channelPicture channelDescription bio subscriptions createdAt')
                    .limit(50)
                    .lean()
            );
        } else {
            queries.push(Promise.resolve([]));
        }

        const [contentDocs, channelDocs] = await Promise.all(queries);

        // ── Score & separate content by type ─────────────────────────────────
        const buckets = { video: [], audio: [], short: [], post: [] };

        contentDocs.forEach(item => {
            const score = scoreItem(item);
            if (score <= 0) return;
            const thumbnail = getCfUrl(item.thumbnailKey);
            // Posts store their image in imageKey (not thumbnailKey)
            const imageUrl = item.imageKey ? getCfUrl(item.imageKey)
                : (item.imageKeys?.length ? getCfUrl(item.imageKeys[0]) : null);
            const channelPic = item.userId?.channelPicture;
            buckets[item.contentType]?.push({
                _id: item._id,
                contentType: item.contentType,
                title: item.title,
                description: item.description,
                duration: item.duration,
                thumbnailUrl: thumbnail || (item.contentType === 'post' ? imageUrl : null),
                imageUrl,
                views: item.views,
                likes: Array.isArray(item.likes) ? item.likes.length : (item.likes || 0),
                dislikes: item.dislikes || 0,
                tags: item.tags || [],
                createdAt: item.createdAt,
                user: {
                    _id: item.userId?._id,
                    userName: item.userId?.userName,
                    channelName: item.userId?.channelName,
                    channelHandle: item.userId?.channelHandle,
                    channelPicture: channelPic,
                },
                searchScore: score,
            });
        });

        // Sort each bucket by score
        Object.keys(buckets).forEach(k => buckets[k].sort((a, b) => b.searchScore - a.searchScore));

        // Score channels
        const scoredChannels = channelDocs
            .map(user => {
                const score = scoreChannel(user);
                return score > 0 ? {
                    _id: user._id,
                    type: 'channel',
                    userName: user.userName,
                    channelName: user.channelName || user.userName,
                    channelHandle: user.channelHandle,
                    channelPicture: user.channelPicture,
                    channelDescription: user.channelDescription || user.bio,
                    subscriberCount: user.subscriptions?.length || 0,
                    createdAt: user.createdAt,
                    searchScore: score,
                } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.searchScore - a.searchScore);

        // ── Return ────────────────────────────────────────────────────────────
        if (!wantAll) {
            // Single-type mode: paginate the one relevant bucket / channel list
            const list = type === 'channel' ? scoredChannels : buckets[type] || [];
            const total = list.length;
            const paginated = list.slice(skip, skip + parseInt(limit));
            return res.json({
                results: paginated,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages: Math.ceil(total / parseInt(limit)),
                    totalCount: total,
                    hasNextPage: skip + parseInt(limit) < total,
                },
                type,
                query,
            });
        }

        // All-type mode: paginate each bucket, channels in first page
        const paginateBucket = (arr) => arr.slice(skip, skip + parseInt(limit));
        const totalCount = Object.values(buckets).reduce((s, a) => s + a.length, 0) + scoredChannels.length;

        // Record search for suggestions
        SearchHistory.recordSearch(userId, query.trim(), totalCount).catch(() => { });

        res.json({
            videos: paginateBucket(buckets.video),
            audio: paginateBucket(buckets.audio),
            shorts: paginateBucket(buckets.short),
            posts: paginateBucket(buckets.post),
            channels: parseInt(page) === 1 ? scoredChannels.slice(0, 6) : [], // channels only on page 1
            pagination: {
                currentPage: parseInt(page),
                hasNextPage: skip + parseInt(limit) < Math.max(...Object.values(buckets).map(a => a.length)),
                totalCount,
            },
            query,
            searchHashtags,
            searchWords,
        });

    } catch (error) {
        console.error('Error in unified search:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
