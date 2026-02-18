/**
 * Profile Controller
 * Creator's profile management: content CRUD, settings, engagement stats
 *
 * Endpoints:
 * - GET    /api/v2/profile/content           - Get creator's own content (with engagement stats)
 * - PUT    /api/v2/profile/content/:id       - Update content (title, description, visibility, commentsEnabled)
 * - DELETE /api/v2/profile/content/:id       - Delete content (with warning confirmation via ?confirm=true)
 * - PUT    /api/v2/profile/settings          - Update profile settings (channelName, userName, bio, achievements, etc.)
 * - GET    /api/v2/profile/settings          - Get current profile settings
 */

import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import Comment from '../../models/comment.model.js';
import WatchHistory from '../../models/watchHistory.model.js';
import VideoReaction from '../../models/videoReaction.model.js';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getCfUrl } from '../../config/cloudfront.js';

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Get creator's own content with engagement stats
 * Query: type (video|short|audio|post), sort (popular|latest), page, limit, search
 */
export const getMyContent = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { type, sort = 'latest', page = 1, limit = 12, search } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const query = { userId };
        if (type && ['video', 'short', 'audio', 'post'].includes(type)) {
            query.contentType = type;
        }
        if (search) {
            query.title = { $regex: search, $options: 'i' };
        }

        const sortBy = sort === 'popular' ? { views: -1, likeCount: -1 } : { createdAt: -1 };

        const [contents, total] = await Promise.all([
            Content.find(query).sort(sortBy).skip(skip).limit(parseInt(limit)).lean(),
            Content.countDocuments(query)
        ]);

        // Enrich with engagement stats and signed URLs
        const enrichedContents = await Promise.all(contents.map(async (item) => {
            const commentCount = await Comment.countDocuments({
                videoId: item._id,
                parentCommentId: { $exists: false }
            });

            return {
                _id: item._id,
                contentType: item.contentType,
                title: item.title,
                description: item.description,
                postContent: item.postContent,
                duration: item.duration,
                views: item.views || 0,
                likeCount: item.likeCount || 0,
                dislikeCount: item.dislikeCount || 0,
                shareCount: item.shareCount || 0,
                commentCount,
                averageWatchTime: item.averageWatchTime || 0,
                totalWatchTime: item.totalWatchTime || 0,
                status: item.status,
                visibility: item.visibility,
                commentsEnabled: item.commentsEnabled,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                thumbnailUrl: getCfUrl(item.thumbnailKey),
                imageUrl: getCfUrl(item.imageKey),
            };
        }));

        res.json({
            contents: enrichedContents,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                hasNextPage: skip + parseInt(limit) < total,
            }
        });
    } catch (error) {
        console.error('❌ Error fetching creator content:', error);
        res.status(500).json({ error: 'Failed to fetch content' });
    }
};

/**
 * Update content metadata
 * Only the creator can update their own content
 * Updatable fields: title, description, visibility, commentsEnabled, tags, category
 */
export const updateContent = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;

        if (!userId) return res.status(401).json({ error: 'Authentication required' });
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid content ID' });

        const content = await Content.findById(id);
        if (!content) return res.status(404).json({ error: 'Content not found' });
        if (content.userId.toString() !== userId) return res.status(403).json({ error: 'Not authorized' });

        const { title, description, visibility, commentsEnabled, tags, category } = req.body;

        const update = {};
        if (title !== undefined) update.title = title;
        if (description !== undefined) update.description = description;
        if (visibility !== undefined && ['public', 'unlisted', 'private'].includes(visibility)) {
            update.visibility = visibility;
        }
        if (typeof commentsEnabled === 'boolean') update.commentsEnabled = commentsEnabled;
        if (tags !== undefined) update.tags = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
        if (category !== undefined) update.category = category;

        const updated = await Content.findByIdAndUpdate(id, update, { new: true });

        res.json({
            success: true,
            message: 'Content updated successfully',
            content: {
                _id: updated._id,
                title: updated.title,
                description: updated.description,
                visibility: updated.visibility,
                commentsEnabled: updated.commentsEnabled,
                tags: updated.tags,
                category: updated.category,
            }
        });
    } catch (error) {
        console.error('❌ Error updating content:', error);
        res.status(500).json({ error: 'Failed to update content' });
    }
};

/**
 * Delete content
 * Requires ?confirm=true query param for safety
 * Only the creator can delete their own content
 * Also cleans up: comments, reactions, watch history entries
 */
export const deleteContent = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;
        const { confirm } = req.query;

        if (!userId) return res.status(401).json({ error: 'Authentication required' });
        if (confirm !== 'true') return res.status(400).json({ error: 'Confirmation required. Add ?confirm=true' });
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid content ID' });

        const content = await Content.findById(id);
        if (!content) return res.status(404).json({ error: 'Content not found' });
        if (content.userId.toString() !== userId) return res.status(403).json({ error: 'Not authorized' });

        // Clean up related data
        await Promise.all([
            Comment.deleteMany({ videoId: id }),
            VideoReaction.deleteMany({ videoId: id }),
            WatchHistory.deleteMany({ contentId: id }),
        ]);

        // Clean up S3 objects (fire and forget) — includes all variants
        const keysToDelete = [
            content.originalKey,
            content.processedKey,
            content.thumbnailKey,
            content.imageKey,
            content.hlsMasterKey,
            content.hlsKey,
        ].filter(Boolean);
        if (content.imageKeys?.length > 0) keysToDelete.push(...content.imageKeys);
        // Delete HLS segment files if hlsKey points to a directory
        if (content.hlsKey) {
            const hlsDir = content.hlsKey.substring(0, content.hlsKey.lastIndexOf('/'));
            try {
                const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
                const listed = await s3Client.send(new ListObjectsV2Command({
                    Bucket: process.env.S3_BUCKET, Prefix: hlsDir + '/'
                }));
                if (listed.Contents) keysToDelete.push(...listed.Contents.map(o => o.Key));
            } catch { /* ignore listing errors */ }
        }

        Promise.all(keysToDelete.map(key =>
            s3Client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key })).catch(() => { })
        )).catch(() => { });

        await Content.findByIdAndDelete(id);

        res.json({
            success: true,
            message: 'Content deleted successfully',
        });
    } catch (error) {
        console.error('❌ Error deleting content:', error);
        res.status(500).json({ error: 'Failed to delete content' });
    }
};

/**
 * Delete a comment (only the content creator can delete others' comments is NOT allowed)
 * Users can only delete their own comments. Content creator can delete their own comments.
 */
export const deleteComment = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { commentId } = req.params;

        if (!userId) return res.status(401).json({ error: 'Authentication required' });
        if (!mongoose.Types.ObjectId.isValid(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });

        const comment = await Comment.findById(commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });

        // Only the comment author can delete their own comment
        if (comment.userId.toString() !== userId) {
            return res.status(403).json({ error: 'You can only delete your own comments' });
        }

        // Delete the comment and all its replies
        await Comment.deleteMany({
            $or: [
                { _id: commentId },
                { parentCommentId: commentId }
            ]
        });

        res.json({ success: true, message: 'Comment deleted' });
    } catch (error) {
        console.error('❌ Error deleting comment:', error);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
};

/**
 * Update profile settings
 * Fields: channelName, userName, bio, achievements, channelDescription
 */
export const updateProfileSettings = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { channelName, userName, bio, achievements, channelDescription } = req.body;

        const update = {};
        if (channelName !== undefined) {
            // Check uniqueness of channelName
            const existing = await User.findOne({
                channelName: { $regex: new RegExp(`^${channelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
                _id: { $ne: userId }
            });
            if (existing) return res.status(409).json({ error: 'Channel name already taken' });
            update.channelName = channelName;
        }
        if (userName !== undefined) update.userName = userName;
        if (bio !== undefined) update.bio = bio;
        if (channelDescription !== undefined) update.channelDescription = channelDescription;
        if (achievements !== undefined) {
            update.achievements = Array.isArray(achievements) ? achievements : [achievements];
        }

        const user = await User.findByIdAndUpdate(userId, update, { new: true }).select(
            'userName channelName channelHandle channelDescription bio achievements roles profilePicture channelPicture'
        );

        res.json({
            success: true,
            message: 'Profile updated successfully',
            user
        });
    } catch (error) {
        console.error('❌ Error updating profile:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
};

/**
 * Get current profile settings
 */
export const getProfileSettings = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const user = await User.findById(userId).select(
            'contact userName channelName channelHandle channelDescription bio achievements roles profilePicture channelPicture historyPaused subscriptions'
        ).populate('subscriptions', 'channelName channelHandle profilePicture channelPicture');

        if (!user) return res.status(404).json({ error: 'User not found' });

        const channelPictureUrl = user.channelPicture
            ? getCfUrl(user.channelPicture)
            : null;
        const profilePictureUrl = user.profilePicture
            ? getCfUrl(user.profilePicture)
            : null;

        // Content stats
        const contentCounts = await Content.aggregate([
            { $match: { userId: user._id } },
            { $group: { _id: '$contentType', count: { $sum: 1 } } }
        ]);
        const counts = { video: 0, short: 0, audio: 0, post: 0 };
        contentCounts.forEach(c => { counts[c._id] = c.count; });

        const subscriberCount = await User.countDocuments({ subscriptions: user._id });

        // For subscriptions avoid expensive S3 head/URL checks — return stored picture key/url as-is.
        const subscriptions = (user.subscriptions || []).slice(0, 20).map((sub) => ({
            _id: sub._id,
            channelName: sub.channelName,
            channelHandle: sub.channelHandle || null,
            channelPicture: sub.channelPicture || null,
        }));

        res.json({
            user: {
                _id: user._id,
                userName: user.userName,
                contact: user.contact,
                channelName: user.channelName,
                channelHandle: user.channelHandle || null,
                channelDescription: user.channelDescription || '',
                bio: user.bio || '',
                achievements: user.achievements || [],
                roles: user.roles || [],
                channelPicture: channelPictureUrl || user.channelPicture,
                profilePicture: profilePictureUrl || user.profilePicture,
                historyPaused: user.historyPaused || false,
                contentCounts: counts,
                subscriberCount,
                subscriptions,
            }
        });
    } catch (error) {
        console.error('❌ Error fetching profile settings:', error);
        res.status(500).json({ error: 'Failed to fetch profile settings' });
    }
};

/**
 * Get analytics data for a specific content item
 * Returns: views, engagement, watch history stats, daily view estimates
 */
export const getContentAnalytics = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid content ID' });

        const content = await Content.findById(id).lean();
        if (!content) return res.status(404).json({ error: 'Content not found' });
        if (content.userId.toString() !== userId) return res.status(403).json({ error: 'Not authorized' });

        // Parallel fetch: comments, reactions, watch history, signed URLs
        const [commentCount, likes, dislikes, watchEntries, thumbnailUrl, imageUrl] = await Promise.all([
            Comment.countDocuments({ videoId: id, parentCommentId: { $exists: false } }),
            VideoReaction.countDocuments({ videoId: id, type: 'like' }),
            VideoReaction.countDocuments({ videoId: id, type: 'dislike' }),
            WatchHistory.find({ contentId: id }).select('sessions watchTime watchPercentage completedWatch').lean(),
            getCfUrl(content.thumbnailKey),
            getCfUrl(content.imageKey),
        ]);

        // Compute daily views from watchHistory sessions (last 30 days)
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
        const dailyViews = {};
        for (let i = 0; i < 30; i++) {
            const d = new Date(now.getTime() - i * 86400000);
            dailyViews[d.toISOString().split('T')[0]] = 0;
        }
        watchEntries.forEach(entry => {
            (entry.sessions || []).forEach(session => {
                if (session.timestamp && new Date(session.timestamp) >= thirtyDaysAgo) {
                    const day = new Date(session.timestamp).toISOString().split('T')[0];
                    if (dailyViews[day] !== undefined) dailyViews[day]++;
                }
            });
        });

        const totalWatchSessions = watchEntries.reduce((acc, e) => acc + (e.sessions?.length || 0), 0);
        const completedCount = watchEntries.filter(e => e.completedWatch).length;
        const avgWatchPercent = watchEntries.length > 0
            ? watchEntries.reduce((acc, e) => acc + (e.watchPercentage || 0), 0) / watchEntries.length
            : 0;

        const engagementRate = content.views > 0
            ? parseFloat(((likes + commentCount) / content.views * 100).toFixed(1))
            : 0;

        res.json({
            content: {
                _id: content._id,
                title: content.title,
                description: content.description,
                contentType: content.contentType,
                duration: content.duration,
                status: content.status,
                visibility: content.visibility,
                tags: content.tags,
                category: content.category,
                createdAt: content.createdAt,
                thumbnailUrl,
                imageUrl,
            },
            stats: {
                views: content.views || 0,
                likes,
                dislikes,
                commentCount,
                averageWatchTime: content.averageWatchTime || 0,
                totalWatchTime: content.totalWatchTime || 0,
                completionRate: watchEntries.length > 0 ? parseFloat(((completedCount / watchEntries.length) * 100).toFixed(1)) : 0,
                avgWatchPercentage: parseFloat(avgWatchPercent.toFixed(1)),
                totalWatchSessions,
                engagementRate,
                uniqueViewers: watchEntries.length,
            },
            dailyViews: Object.entries(dailyViews).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, views: count })),
        });
    } catch (error) {
        console.error('❌ Error fetching content analytics:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
};
