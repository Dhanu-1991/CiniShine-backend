/**
 * Channel Controller
 * YouTube-like channel page data: public profile, content tabs, subscriber count
 *
 * Endpoints:
 * - GET /api/v2/channel/:channelName          - Get channel page data by channelName
 * - GET /api/v2/channel/:channelName/content   - Get channel content (popular/latest, by type)
 */

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import Comment from '../../models/comment.model.js';
import { getCfUrl, getCfHlsMasterUrl } from '../../config/cloudfront.js';

/**
 * Get channel page data by channelName
 * Returns: channel info, subscriber count, content counts, roles, newest releases
 */
export const getChannelPage = async (req, res) => {
    try {
        const { channelIdentifier } = req.params;
        const currentUserId = req.user?.id;

        if (!channelIdentifier) return res.status(400).json({ error: 'Channel identifier required' });

        // Find user by channelHandle first, then fall back to channelName, then _id
        let user = await User.findOne({
            channelHandle: channelIdentifier.toLowerCase()
        });
        if (!user) {
            user = await User.findOne({
                channelName: { $regex: new RegExp(`^${channelIdentifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
            });
        }
        if (!user && mongoose.Types.ObjectId.isValid(channelIdentifier)) {
            user = await User.findById(channelIdentifier);
        }

        if (!user) return res.status(404).json({ error: 'Channel not found' });

        // Subscriber/follower count: use override if set by superadmin, else count actual
        const subscriberCount = (user.subscriberCountOverride !== null && user.subscriberCountOverride !== undefined)
            ? user.subscriberCountOverride
            : await User.countDocuments({ subscriptions: user._id });

        // Check if current user is subscribed
        let isSubscribed = false;
        if (currentUserId) {
            const currentUser = await User.findById(currentUserId);
            isSubscribed = currentUser?.subscriptions?.some(id => id.toString() === user._id.toString()) || false;
        }

        // Content counts by type (only public + completed)
        const contentCounts = await Content.aggregate([
            { $match: { userId: user._id, status: 'completed', visibility: 'public' } },
            { $group: { _id: '$contentType', count: { $sum: 1 } } }
        ]);

        const counts = { video: 0, short: 0, audio: 0, post: 0 };
        contentCounts.forEach(c => { counts[c._id] = c.count; });

        // Newest releases (latest 6 items across all types, public only)
        const newestReleases = await Content.find({
            userId: user._id,
            status: 'completed',
            visibility: 'public'
        })
            .sort({ createdAt: -1 })
            .limit(6)
            .lean();

        const newestWithUrls = await Promise.all(newestReleases.map(async (item) => {
            const mediaKey = item.processedKey || item.originalKey;
            return ({
                _id: item._id,
                contentType: item.contentType,
                title: item.title,
                description: item.description,
                duration: item.duration,
                views: item.views || 0,
                likeCount: item.likeCount || 0,
                createdAt: item.createdAt,
                thumbnailUrl: getCfUrl(item.thumbnailKey),
                imageUrl: getCfUrl(item.imageKey),
                hlsMasterUrl: item.hlsMasterKey ? getCfHlsMasterUrl(item.hlsMasterKey) : null,
                videoUrl: (item.contentType === 'video' || item.contentType === 'short') && mediaKey ? getCfUrl(mediaKey) : null,
                audioUrl: item.contentType === 'audio' && mediaKey ? getCfUrl(mediaKey) : null,
            });
        }));

        // Popular content (top 6 by views, public only)
        const popularContent = await Content.find({
            userId: user._id,
            status: 'completed',
            visibility: 'public'
        })
            .sort({ views: -1 })
            .limit(6)
            .lean();

        const popularWithUrls = await Promise.all(popularContent.map(async (item) => {
            const mediaKey = item.processedKey || item.originalKey;
            return ({
                _id: item._id,
                contentType: item.contentType,
                title: item.title,
                description: item.description,
                duration: item.duration,
                views: item.views || 0,
                likeCount: item.likeCount || 0,
                createdAt: item.createdAt,
                thumbnailUrl: getCfUrl(item.thumbnailKey),
                imageUrl: getCfUrl(item.imageKey),
                hlsMasterUrl: item.hlsMasterKey ? getCfHlsMasterUrl(item.hlsMasterKey) : null,
                videoUrl: (item.contentType === 'video' || item.contentType === 'short') && mediaKey ? getCfUrl(mediaKey) : null,
                audioUrl: item.contentType === 'audio' && mediaKey ? getCfUrl(mediaKey) : null,
            });
        }));

        // Channel picture URL
        const channelPictureUrl = user.channelPicture
            ? getCfUrl(user.channelPicture)
            : null;
        const profilePictureUrl = user.profilePicture
            ? getCfUrl(user.profilePicture)
            : null;

        res.json({
            channel: {
                _id: user._id,
                channelName: user.channelName,
                channelHandle: user.channelHandle || '',
                userName: user.userName,
                channelDescription: user.channelDescription || '',
                bio: user.bio || '',
                achievements: user.achievements || [],
                roles: user.roles || [],
                channelPicture: channelPictureUrl || user.channelPicture,
                profilePicture: profilePictureUrl || user.profilePicture,
                subscriberCount,
                isSubscribed,
                contentCounts: counts,
                createdAt: user._id.getTimestamp ? user._id.getTimestamp() : null,
            },
            newestReleases: newestWithUrls,
            popularContent: popularWithUrls,
        });
    } catch (error) {
        console.error('❌ Error fetching channel page:', error);
        res.status(500).json({ error: 'Failed to fetch channel data' });
    }
};

/**
 * Get channel content by type with popular/latest sorting
 * Query params: type (video|short|audio|post), sort (popular|latest), page, limit
 */
export const getChannelContent = async (req, res) => {
    try {
        const { channelIdentifier } = req.params;
        const { type = 'video', sort = 'latest', page = 1, limit = 12 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        if (!['video', 'short', 'audio', 'post'].includes(type)) {
            return res.status(400).json({ error: 'Invalid content type' });
        }

        let user = await User.findOne({ channelHandle: channelIdentifier.toLowerCase() });
        if (!user) {
            user = await User.findOne({
                channelName: { $regex: new RegExp(`^${channelIdentifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
            });
        }
        if (!user && mongoose.Types.ObjectId.isValid(channelIdentifier)) {
            user = await User.findById(channelIdentifier);
        }
        if (!user) return res.status(404).json({ error: 'Channel not found' });

        // STRICT: Only public + completed content
        const query = {
            userId: user._id,
            contentType: type,
            status: 'completed',
            visibility: 'public'
        };

        const sortBy = sort === 'popular' ? { views: -1, likeCount: -1 } : sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };

        const [contents, total] = await Promise.all([
            Content.find(query).sort(sortBy).skip(skip).limit(parseInt(limit)).lean(),
            Content.countDocuments(query)
        ]);

        const contentsWithUrls = await Promise.all(contents.map(async (item) => {
            const mediaKey = item.processedKey || item.originalKey;
            return ({
                _id: item._id,
                contentType: item.contentType,
                title: item.title,
                description: item.description,
                postContent: item.postContent,
                duration: item.duration,
                views: item.views || 0,
                likeCount: item.likeCount || 0,
                createdAt: item.createdAt,
                thumbnailUrl: getCfUrl(item.thumbnailKey),
                imageUrl: getCfUrl(item.imageKey),
                hlsMasterUrl: item.hlsMasterKey ? getCfHlsMasterUrl(item.hlsMasterKey) : null,
                videoUrl: (item.contentType === 'video' || item.contentType === 'short') && mediaKey ? getCfUrl(mediaKey) : null,
                audioUrl: item.contentType === 'audio' && mediaKey ? getCfUrl(mediaKey) : null,
            });
        }));

        res.json({
            contents: contentsWithUrls,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                hasNextPage: skip + parseInt(limit) < total,
            }
        });
    } catch (error) {
        console.error('❌ Error fetching channel content:', error);
        res.status(500).json({ error: 'Failed to fetch channel content' });
    }
};

/**
 * Check which followed channels have new content since a given date
 * POST /api/v2/channel/new-content-check
 * Body: { channelIds: string[], since: ISO date string }
 * Returns: { channelsWithNew: string[] }
 */
export const checkNewContent = async (req, res) => {
    try {
        const { channelIds, since } = req.body;

        if (!channelIds || !Array.isArray(channelIds) || channelIds.length === 0) {
            return res.json({ channelsWithNew: [] });
        }

        const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const validIds = channelIds
            .filter(id => mongoose.Types.ObjectId.isValid(id))
            .map(id => new mongoose.Types.ObjectId(id));

        if (validIds.length === 0) {
            return res.json({ channelsWithNew: [] });
        }

        // Find content uploaded after sinceDate from any of the given channel user IDs
        const newContent = await Content.distinct('userId', {
            userId: { $in: validIds },
            createdAt: { $gt: sinceDate },
            visibility: 'public',
        });

        res.json({ channelsWithNew: newContent.map(id => id.toString()) });
    } catch (error) {
        console.error('❌ Error checking new content:', error);
        res.status(500).json({ error: 'Failed to check new content', channelsWithNew: [] });
    }
};

/**
 * Get top 20 creator followers of a channel, sorted by their own follower count.
 * GET /api/v2/channel/:channelIdentifier/followers
 */
export const getChannelFollowers = async (req, res) => {
    try {
        const { channelIdentifier } = req.params;

        // Resolve channel
        let user = await User.findOne({ channelHandle: channelIdentifier.toLowerCase() });
        if (!user) {
            user = await User.findOne({
                channelName: { $regex: new RegExp(`^${channelIdentifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
            });
        }
        if (!user && mongoose.Types.ObjectId.isValid(channelIdentifier)) {
            user = await User.findById(channelIdentifier);
        }
        if (!user) return res.status(404).json({ error: 'Channel not found' });

        // Find creator followers (users who subscribe to this channel)
        const rawFollowers = await User.find({
            subscriptions: user._id,
            channelName: { $exists: true, $nin: [null, ''] }
        })
            .select('_id channelName channelHandle channelPicture subscriberCountOverride')
            .limit(50)
            .lean();

        // Get follower counts efficiently with parallel individual queries
        const followers = await Promise.all(
            rawFollowers.map(async (f) => ({
                _id: f._id,
                channelName: f.channelName,
                channelHandle: f.channelHandle,
                channelPicture: f.channelPicture ? getCfUrl(f.channelPicture) : null,
                followerCount: f.subscriberCountOverride != null
                    ? f.subscriberCountOverride
                    : await User.countDocuments({ subscriptions: f._id })
            }))
        );

        // Sort by follower count and take top 20
        followers.sort((a, b) => b.followerCount - a.followerCount);
        res.json({ followers: followers.slice(0, 20) });
    } catch (error) {
        console.error('❌ Error fetching channel followers:', error);
        res.status(500).json({ error: 'Failed to fetch followers' });
    }
};
