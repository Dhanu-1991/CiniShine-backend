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
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const s3ExistenceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function s3ObjectExists(bucket, key) {
    const cacheKey = `${bucket}:${key}`;
    const cached = s3ExistenceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.exists;
    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        s3ExistenceCache.set(cacheKey, { exists: true, timestamp: Date.now() });
        return true;
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            s3ExistenceCache.set(cacheKey, { exists: false, timestamp: Date.now() });
            return false;
        }
        return true;
    }
}

// Extract S3 key from a full URL or return as-is if already a key
function extractS3Key(urlOrKey) {
    if (!urlOrKey) return null;
    if (urlOrKey.startsWith('http')) {
        try {
            const url = new URL(urlOrKey);
            return url.pathname.slice(1); // remove leading "/"
        } catch {
            return urlOrKey;
        }
    }
    return urlOrKey;
}

async function getSignedUrlIfExists(bucket, key, expiresIn = 3600) {
    if (!key) return null;
    const resolvedKey = extractS3Key(key);
    if (!resolvedKey) return null;
    if (!(await s3ObjectExists(bucket, resolvedKey))) return null;
    try {
        return await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucket, Key: resolvedKey }), { expiresIn });
    } catch {
        return null;
    }
}

/**
 * Get channel page data by channelName
 * Returns: channel info, subscriber count, content counts, roles, newest releases
 */
export const getChannelPage = async (req, res) => {
    try {
        const { channelName } = req.params;
        const currentUserId = req.user?.id;

        if (!channelName) return res.status(400).json({ error: 'Channel name required' });

        // Find user by channelName (case-insensitive)
        const user = await User.findOne({
            channelName: { $regex: new RegExp(`^${channelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });

        if (!user) return res.status(404).json({ error: 'Channel not found' });

        // Subscriber count: count users who have this user in their subscriptions array
        const subscriberCount = await User.countDocuments({ subscriptions: user._id });

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

        const newestWithUrls = await Promise.all(newestReleases.map(async (item) => ({
            _id: item._id,
            contentType: item.contentType,
            title: item.title,
            description: item.description,
            duration: item.duration,
            views: item.views || 0,
            likeCount: item.likeCount || 0,
            createdAt: item.createdAt,
            thumbnailUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, item.thumbnailKey),
            imageUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, item.imageKey),
        })));

        // Popular content (top 6 by views, public only)
        const popularContent = await Content.find({
            userId: user._id,
            status: 'completed',
            visibility: 'public'
        })
            .sort({ views: -1 })
            .limit(6)
            .lean();

        const popularWithUrls = await Promise.all(popularContent.map(async (item) => ({
            _id: item._id,
            contentType: item.contentType,
            title: item.title,
            description: item.description,
            duration: item.duration,
            views: item.views || 0,
            likeCount: item.likeCount || 0,
            createdAt: item.createdAt,
            thumbnailUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, item.thumbnailKey),
            imageUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, item.imageKey),
        })));

        // Channel picture URL
        const channelPictureUrl = user.channelPicture
            ? await getSignedUrlIfExists(process.env.S3_BUCKET, user.channelPicture)
            : null;
        const profilePictureUrl = user.profilePicture
            ? await getSignedUrlIfExists(process.env.S3_BUCKET, user.profilePicture)
            : null;

        res.json({
            channel: {
                _id: user._id,
                channelName: user.channelName,
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
        const { channelName } = req.params;
        const { type = 'video', sort = 'latest', page = 1, limit = 12 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        if (!['video', 'short', 'audio', 'post'].includes(type)) {
            return res.status(400).json({ error: 'Invalid content type' });
        }

        const user = await User.findOne({
            channelName: { $regex: new RegExp(`^${channelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });
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

        const contentsWithUrls = await Promise.all(contents.map(async (item) => ({
            _id: item._id,
            contentType: item.contentType,
            title: item.title,
            description: item.description,
            postContent: item.postContent,
            duration: item.duration,
            views: item.views || 0,
            likeCount: item.likeCount || 0,
            createdAt: item.createdAt,
            thumbnailUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, item.thumbnailKey),
            imageUrl: await getSignedUrlIfExists(process.env.S3_BUCKET, item.imageKey),
        })));

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
