import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import ContentArchive from '../../models/contentArchive.model.js';
import AdminAuditLog from '../../models/adminAuditLog.model.js';
import AdminNotification from '../../models/adminNotification.model.js';
import ContentView from '../../models/contentView.model.js';
import User from '../../models/user.model.js';

const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getClientIp(req) {
    return req.ip || req.connection?.remoteAddress || '';
}

/**
 * POST /admin/content/:id/hide
 * Toggle content visibility (hide/unhide). Content is NOT archived.
 */
export const hideContent = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid content ID' });
        }

        const content = await Content.findById(id);
        if (!content) {
            return res.status(404).json({ success: false, message: 'Content not found' });
        }

        // Toggle: if public → hidden (private), if private → public
        const wasHidden = content.visibility === 'private';
        content.visibility = wasHidden ? 'public' : 'private';
        await content.save();

        const action = wasHidden ? 'content_unhide' : 'content_hide';

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action,
            target_type: 'content',
            target_id: content._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: reason || ''
        });

        return res.status(200).json({
            success: true,
            message: wasHidden ? 'Content unhidden' : 'Content hidden',
            visibility: content.visibility
        });
    } catch (error) {
        console.error('Hide content error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/content/:id/remove
 * Move content to 24h archive (soft delete). Content becomes unavailable to users.
 */
export const removeContent = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid content ID' });
        }

        const content = await Content.findById(id);
        if (!content) {
            return res.status(404).json({ success: false, message: 'Content not found' });
        }

        // Check if already archived
        const existingArchive = await ContentArchive.findOne({
            content_id: content._id,
            permanently_deleted: false,
            restored_at: null
        });
        if (existingArchive) {
            return res.status(400).json({ success: false, message: 'Content is already archived' });
        }

        const now = new Date();

        // Build HLS prefix for later cleanup
        let hlsPrefix = '';
        if (content.hlsMasterKey) {
            hlsPrefix = content.hlsMasterKey.substring(0, content.hlsMasterKey.lastIndexOf('/') + 1);
        }

        // Create archive entry with S3 key snapshot
        await ContentArchive.create({
            content_id: content._id,
            originalKey: content.originalKey || '',
            hlsMasterKey: content.hlsMasterKey || '',
            thumbnailKey: content.thumbnailKey || '',
            imageKey: content.imageKey || '',
            imageKeys: content.imageKeys || [],
            hlsPrefix,
            content_snapshot: {
                title: content.title,
                contentType: content.contentType,
                userId: content.userId,
                description: content.description,
                tags: content.tags,
                views: content.views,
                createdAt: content.createdAt
            },
            removed_by_admin: req.admin._id,
            removed_at: now,
            delete_scheduled_at: new Date(now.getTime() + ARCHIVE_TTL_MS),
            reason: reason || ''
        });

        // Mark content as hidden so it doesn't appear to users
        content.visibility = 'private';
        content.status = 'failed'; // Re-purpose status to indicate removed
        await content.save();

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'content_remove',
            target_type: 'content',
            target_id: content._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: reason || ''
        });

        await AdminNotification.create({
            type: 'content_removed',
            title: 'Content Removed',
            message: `"${content.title || 'Untitled'}" archived by ${req.admin.name}. Auto-delete in 24h.`,
            severity: 'info',
            metadata: { content_id: content._id, admin_id: req.admin._id }
        });

        return res.status(200).json({
            success: true,
            message: 'Content moved to archive. Will be permanently deleted in 24 hours.',
            delete_scheduled_at: new Date(now.getTime() + ARCHIVE_TTL_MS)
        });
    } catch (error) {
        console.error('Remove content error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/content/:id/restore
 * Restore content from archive (within 24h window).
 */
export const restoreContent = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid content ID' });
        }

        const archive = await ContentArchive.findOne({
            content_id: id,
            permanently_deleted: false,
            restored_at: null
        });

        if (!archive) {
            return res.status(404).json({ success: false, message: 'No active archive entry found for this content' });
        }

        if (archive.delete_scheduled_at <= new Date()) {
            return res.status(400).json({ success: false, message: 'Archive window has expired. Content may have been permanently deleted.' });
        }

        // Restore the content
        const content = await Content.findById(id);
        if (!content) {
            return res.status(404).json({ success: false, message: 'Content record not found in database' });
        }

        content.visibility = 'public';
        content.status = 'completed';
        await content.save();

        archive.restored_by_admin = req.admin._id;
        archive.restored_at = new Date();
        await archive.save();

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'content_restore',
            target_type: 'content',
            target_id: content._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: `Restored from archive`
        });

        await AdminNotification.create({
            type: 'content_restored',
            title: 'Content Restored',
            message: `"${content.title || 'Untitled'}" restored by ${req.admin.name}.`,
            severity: 'info',
            metadata: { content_id: content._id, admin_id: req.admin._id }
        });

        return res.status(200).json({
            success: true,
            message: 'Content restored successfully'
        });
    } catch (error) {
        console.error('Restore content error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * DELETE /admin/content/:id
 * Disabled until archive TTL expires — enforced server-side.
 */
export const deleteContent = async (req, res) => {
    try {
        const { id } = req.params;

        const archive = await ContentArchive.findOne({
            content_id: id,
            permanently_deleted: false,
            restored_at: null
        });

        if (!archive) {
            return res.status(404).json({ success: false, message: 'Content not in archive' });
        }

        if (archive.delete_scheduled_at > new Date()) {
            const remaining = archive.delete_scheduled_at.getTime() - Date.now();
            const hours = Math.ceil(remaining / (1000 * 60 * 60));
            return res.status(403).json({
                success: false,
                message: `Cannot permanently delete until archive window expires (~${hours}h remaining). The system will auto-purge.`
            });
        }

        // Manual purge is allowed after TTL — but normally the worker handles this
        return res.status(200).json({
            success: true,
            message: 'Content will be purged by the scheduled worker.'
        });
    } catch (error) {
        console.error('Delete content error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/archive
 * List archived content with deletion timestamps.
 */
export const listArchive = async (req, res) => {
    try {
        const { page = 1, limit = 20, status } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const filter = {};
        if (status === 'pending') {
            filter.permanently_deleted = false;
            filter.restored_at = null;
        } else if (status === 'restored') {
            filter.restored_at = { $ne: null };
        } else if (status === 'deleted') {
            filter.permanently_deleted = true;
        }

        const [archives, total] = await Promise.all([
            ContentArchive.find(filter)
                .sort({ removed_at: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .populate('removed_by_admin', 'name contact')
                .populate('restored_by_admin', 'name contact'),
            ContentArchive.countDocuments(filter)
        ]);

        return res.status(200).json({
            success: true,
            archives,
            pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('List archive error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/content/:id
 * Get single content details (for admin review).
 */
export const getContentDetails = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid content ID' });
        }

        const content = await Content.findById(id).populate('userId', 'userName contact channelName channelHandle profilePicture');
        if (!content) {
            return res.status(404).json({ success: false, message: 'Content not found' });
        }

        // Check if archived
        const archive = await ContentArchive.findOne({ content_id: id, permanently_deleted: false, restored_at: null });

        return res.status(200).json({
            success: true,
            content,
            isArchived: !!archive,
            archive: archive || null
        });
    } catch (error) {
        console.error('Get content details error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/creator/:id/analytics
 * Analytics for a creator: views, likes, content count, watch time, etc.
 */
export const getCreatorAnalytics = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid creator ID' });
        }

        const creator = await User.findById(id).select('userName channelName channelHandle contact profilePicture channelPicture subscriptions');
        if (!creator) {
            return res.status(404).json({ success: false, message: 'Creator not found' });
        }

        // Aggregate content stats
        const [stats] = await Content.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(id) } },
            {
                $group: {
                    _id: null,
                    totalContent: { $sum: 1 },
                    totalViews: { $sum: '$views' },
                    totalLikes: { $sum: '$likeCount' },
                    totalDislikes: { $sum: '$dislikeCount' },
                    totalShares: { $sum: '$shareCount' },
                    totalWatchTime: { $sum: '$totalWatchTime' },
                    avgWatchTime: { $avg: '$averageWatchTime' }
                }
            }
        ]);

        // Content breakdown by type
        const contentByType = await Content.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(id) } },
            { $group: { _id: '$contentType', count: { $sum: 1 }, views: { $sum: '$views' } } }
        ]);

        // Unique viewers
        const uniqueViewers = await ContentView.countDocuments({
            contentId: { $in: await Content.find({ userId: id }).distinct('_id') }
        });

        // Subscriber count (users who have this creator in their subscriptions)
        const subscriberCount = await User.countDocuments({ subscriptions: id });

        return res.status(200).json({
            success: true,
            creator: {
                id: creator._id,
                userName: creator.userName,
                channelName: creator.channelName,
                channelHandle: creator.channelHandle,
                contact: creator.contact,
                profilePicture: creator.profilePicture,
                channelPicture: creator.channelPicture
            },
            analytics: {
                ...(stats || { totalContent: 0, totalViews: 0, totalLikes: 0, totalDislikes: 0, totalShares: 0, totalWatchTime: 0, avgWatchTime: 0 }),
                uniqueViewers,
                subscriberCount,
                contentByType
            }
        });
    } catch (error) {
        console.error('Creator analytics error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/search/creators
 * Search creators by username, email, ID, or handle.
 */
export const searchCreators = async (req, res) => {
    try {
        const { q, page = 1, limit = 20 } = req.query;
        if (!q || q.trim().length < 2) {
            return res.status(400).json({ success: false, message: 'Search query must be at least 2 characters' });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const query = q.trim();

        let filter;
        // If it's a valid ObjectId, search by ID
        if (mongoose.Types.ObjectId.isValid(query)) {
            filter = { _id: query };
        } else {
            const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter = {
                $or: [
                    { userName: regex },
                    { contact: regex },
                    { channelHandle: regex },
                    { channelName: regex },
                    { fullName: regex }
                ]
            };
        }

        const [users, total] = await Promise.all([
            User.find(filter)
                .select('userName contact channelName channelHandle profilePicture fullName createdAt')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            User.countDocuments(filter)
        ]);

        return res.status(200).json({
            success: true,
            creators: users,
            pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('Search creators error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
