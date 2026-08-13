import mongoose from 'mongoose';
import Content from '../../models/content.model.js';
import ContentArchive from '../../models/contentArchive.model.js';
import ContentReport from '../../models/contentReport.model.js';
import AdminAuditLog from '../../models/adminAuditLog.model.js';
import AdminNotification from '../../models/adminNotification.model.js';
import ContentView from '../../models/contentView.model.js';
import User from '../../models/user.model.js';
import Community from '../../models/community.model.js';
import CommunityMember from '../../models/communityMember.model.js';
import Comment from '../../models/comment.model.js';
import VideoReaction from '../../models/videoReaction.model.js';
import WatchHistory from '../../models/watchHistory.model.js';
import ContentWatchtime from '../../models/contentWatchtime.model.js';
import SecondaryWallet from '../../models/secondaryWallet.model.js';
import KycDetails from '../../models/kycDetails.model.js';
import Payout from '../../models/payout.model.js';
import Purchase from '../../models/purchase.model.js';
import { getCfUrl, getCfHlsMasterUrl } from '../../config/cloudfront.js';
import { sendAdminEmail } from '../../services/adminEmailService.js';
import { S3Client, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET;

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
 * Regular admins can only remove content through the reports workflow (takedown).
 * SuperAdmins can remove any content directly.
 */
export const removeContent = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        // Role check: only superadmin can directly remove content
        if (req.admin.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                message: 'Only SuperAdmins can remove content directly. Admins must use the reports workflow to take down content.'
            });
        }

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

        // Mark content as removed so it doesn't appear anywhere
        content.visibility = 'private';
        content.status = 'removed';
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
            message: `"${content.title || 'Untitled'}" archived by ${req.admin.name}. Can be permanently deleted after 24h.`,
            severity: 'info',
            metadata: { content_id: content._id, admin_id: req.admin._id }
        });

        // Auto-email creator about content removal (non-blocking)
        const creator = await User.findById(content.userId).select('userName contact').lean();
        if (creator?.contact && creator.contact.includes('@')) {
            sendAdminEmail('contentRemoved', creator.contact, {
                creatorName: creator.userName || 'Creator',
                contentTitle: content.title || 'Untitled',
                contentType: content.contentType || 'content',
                reason: reason || '',
                adminName: req.admin.name || 'Admin'
            }).catch(err => console.error('[AdminEmail] Failed to send content removal email:', err.message));
        }

        return res.status(200).json({
            success: true,
            message: 'Content moved to archive. Can be permanently deleted after 24 hours.',
            archive_id: (await ContentArchive.findOne({ content_id: content._id, permanently_deleted: false, restored_at: null }))._id,
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

        // Restore the content — use atomic update to guarantee fields are set
        const content = await Content.findByIdAndUpdate(
            id,
            { $set: { visibility: 'public', status: 'completed' } },
            { new: true }
        );
        if (!content) {
            return res.status(404).json({ success: false, message: 'Content record not found in database' });
        }

        archive.restored_by_admin = req.admin._id;
        archive.restored_at = new Date();
        await archive.save();

        // Auto-resolve any pending/takenDown reports for this content
        await ContentReport.updateMany(
            { contentId: content._id, status: { $in: ['pending', 'resolved'] }, takenDown: true },
            {
                $set: {
                    status: 'resolved',
                    takenDown: false,
                    reviewedBy: req.admin._id,
                    reviewedAt: new Date()
                }
            }
        );

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
 * Permanently delete content after 24h cooldown. Manual action by admin.
 * Deletes S3 assets (thumbnails, originals, HLS) + MongoDB related docs.
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
            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.ceil((remaining % (1000 * 60 * 60)) / (1000 * 60));
            return res.status(403).json({
                success: false,
                message: `Cooldown period active. ${hours}h ${minutes}m remaining before permanent deletion is allowed.`
            });
        }

        // Delete S3 assets
        const keysToDelete = [
            archive.thumbnailKey,
            archive.originalKey,
            archive.hlsMasterKey,
            archive.imageKey,
            ...(archive.imageKeys || [])
        ].filter(Boolean);

        for (const key of keysToDelete) {
            try {
                await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
            } catch (e) {
                console.error(`Failed to delete S3 key ${key}:`, e.message);
            }
        }

        // Delete HLS directory (all segments/playlists)
        if (archive.hlsPrefix) {
            try {
                let continuationToken;
                do {
                    const listRes = await s3.send(new ListObjectsV2Command({
                        Bucket: BUCKET,
                        Prefix: archive.hlsPrefix,
                        ContinuationToken: continuationToken,
                    }));
                    const objects = listRes.Contents || [];
                    for (const obj of objects) {
                        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
                    }
                    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
                } while (continuationToken);
            } catch (e) {
                console.error(`Failed to delete HLS prefix ${archive.hlsPrefix}:`, e.message);
            }
        }

        // Delete related MongoDB documents
        const contentId = archive.content_id;
        await Promise.all([
            Content.deleteOne({ _id: contentId }),
            Comment.deleteMany({ contentId }),
            VideoReaction.deleteMany({ contentId }),
            WatchHistory.deleteMany({ contentId }),
            ContentView.deleteMany({ contentId }),
        ]);

        // Mark archive as permanently deleted
        archive.permanently_deleted = true;
        archive.permanently_deleted_at = new Date();
        await archive.save();

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'content_purge',
            target_type: 'content',
            target_id: contentId,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: `Permanently deleted content and S3 assets`
        });

        return res.status(200).json({
            success: true,
            message: 'Content permanently deleted including all S3 assets.'
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
        const { page = 1, limit = 20, status, search } = req.query;
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

        if (search) {
            const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [
                { 'content_snapshot.title': regex },
                { reason: regex },
                { content_id: regex }
            ];
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

        const contentObj = await Content.findById(id).populate('userId', 'userName contact channelName channelHandle profilePicture channelPicture subscriberCount').lean();
        if (!contentObj) {
            return res.status(404).json({ success: false, message: 'Content not found' });
        }

        const mediaKey = contentObj.processedKey || contentObj.originalKey || contentObj.videoKey || contentObj.mediaKey || contentObj.key;
        const thumbKey = contentObj.thumbnailKey || contentObj.imageKey || contentObj.thumbnailUrl || contentObj.thumbnail;

        const views = Number(contentObj.viewsCount || contentObj.views || 0);
        const watchSec = Number(contentObj.watchTime || contentObj.totalWatchTime || 0);
        const durSec = Number(contentObj.duration || 0);

        const rawComp = contentObj.completionRate;
        const furthestSec = Number(contentObj.furthestPlayheadSeconds || 0);
        let completionRate = 0;
        if (rawComp !== null && rawComp !== undefined) {
            completionRate = Math.min(100, Math.round(rawComp));
        } else if (durSec > 0 && furthestSec > 0) {
            completionRate = Math.min(100, Math.round((furthestSec / durSec) * 100));
        }

        const creator = contentObj.userId ? {
            _id: contentObj.userId._id,
            userName: contentObj.userId.userName,
            channelName: contentObj.userId.channelName,
            channelHandle: contentObj.userId.channelHandle,
            subscriberCount: contentObj.userId.subscriberCount || 0,
            channelPicture: getCfUrl(contentObj.userId.channelPicture || contentObj.userId.profilePicture)
        } : null;

        const enrichedContent = {
            ...contentObj,
            viewsCount: views,
            watchTime: watchSec,
            completionRate,
            ppvPrice: contentObj.ppvPrice || contentObj.price || contentObj.rentalPrice || 0,
            thumbnailUrl: getCfUrl(thumbKey),
            videoUrl: mediaKey ? getCfUrl(mediaKey) : null,
            hlsMasterUrl: contentObj.hlsMasterKey ? getCfHlsMasterUrl(contentObj.hlsMasterKey) : null,
            creator
        };

        const archive = await ContentArchive.findOne({ content_id: id, permanently_deleted: false, restored_at: null });

        return res.status(200).json({
            success: true,
            content: enrichedContent,
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

        const creator = await User.findById(id).select('userName channelName channelHandle contact profilePicture channelPicture subscriptions subscriberCountOverride uniqueViewersOverride');
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
        const computedUniqueViewers = await ContentView.countDocuments({
            contentId: { $in: await Content.find({ userId: id }).distinct('_id') }
        });
        const uniqueViewers = creator.uniqueViewersOverride !== null && creator.uniqueViewersOverride !== undefined
            ? creator.uniqueViewersOverride
            : computedUniqueViewers;

        // Subscriber count (users who have this creator in their subscriptions)
        const computedSubscriberCount = await User.countDocuments({ subscriptions: id });
        const subscriberCount = creator.subscriberCountOverride !== null && creator.subscriberCountOverride !== undefined
            ? creator.subscriberCountOverride
            : computedSubscriberCount;

        return res.status(200).json({
            success: true,
            creator: {
                id: creator._id,
                userName: creator.userName,
                channelName: creator.channelName,
                channelHandle: creator.channelHandle,
                contact: creator.contact,
                profilePicture: getCfUrl(creator.profilePicture || creator.channelPicture),
                channelPicture: getCfUrl(creator.channelPicture || creator.profilePicture)
            },
            analytics: {
                ...(stats || { totalContent: 0, totalViews: 0, totalLikes: 0, totalDislikes: 0, totalShares: 0, totalWatchTime: 0, avgWatchTime: 0 }),
                uniqueViewers,
                subscriberCount,
                subscriberCountOverride: creator.subscriberCountOverride,
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
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const query = q ? q.trim() : '';

        let filter = {};
        if (query) {
            if (mongoose.Types.ObjectId.isValid(query)) {
                filter = { _id: query };
            } else {
                const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                filter = {
                    $or: [
                        { userName: regex },
                        { contact: regex },
                        { email: regex },
                        { channelHandle: regex },
                        { channelName: regex },
                        { fullName: regex }
                    ]
                };
            }
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
            creators: users.map(u => {
                const obj = u.toObject ? u.toObject() : u;
                obj.profilePicture = getCfUrl(obj.profilePicture || obj.channelPicture);
                return obj;
            }),
            pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('Search creators error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/creator/:id/profile
 * Full creator profile: user info, subscriber count, content stats, communities.
 */
export const getCreatorProfile = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid creator ID' });
        }

        const creator = await User.findById(id).select('-password -viewHistory');
        if (!creator) {
            return res.status(404).json({ success: false, message: 'Creator not found' });
        }

        const [subscriberCount, contentCount, communities, wallet, pendingPayout, allPayouts, kycDetails] = await Promise.all([
            creator.subscriberCountOverride !== null && creator.subscriberCountOverride !== undefined
                ? Promise.resolve(creator.subscriberCountOverride)
                : User.countDocuments({ subscriptions: id }),
            Content.countDocuments({ userId: id, status: { $in: ['completed', 'removed'] } }),
            CommunityMember.find({ userId: id, status: 'ACTIVE' })
                .populate('communityId', 'name slug type avatarUrl')
                .lean(),
            SecondaryWallet.findOne({ userId: id }).lean(),
            Payout.findOne({ userId: id, status: 'pending_settlement' }).lean(),
            Payout.find({ userId: id }).sort({ createdAt: -1 }).lean(),
            KycDetails.findOne({ userId: id }).lean(),
        ]);

        // Transform profile picture through CloudFront
        const creatorObj = creator.toObject ? creator.toObject() : { ...creator._doc || creator };
        creatorObj.profilePicture = getCfUrl(creatorObj.profilePicture || creatorObj.channelPicture);
        creatorObj.channelPicture = getCfUrl(creatorObj.channelPicture || creatorObj.profilePicture);

        const isKycVerified = Boolean(
            creator.isKycVerified ||
            creator.kycStatus === 'verified' ||
            (kycDetails && (
                kycDetails.kycStatus === 'verified' ||
                kycDetails.kycStatus === 'approved' ||
                kycDetails.status === 'verified' ||
                kycDetails.status === 'approved'
            ))
        );

        return res.status(200).json({
            success: true,
            creator: creatorObj,
            subscriberCount,
            contentCount,
            communities: communities.map(cm => cm.communityId).filter(Boolean),
            payoutStatus: {
                kycVerified: isKycVerified,
                kycStatus: isKycVerified ? 'verified' : (kycDetails ? kycDetails.status : 'not_submitted'),
                hasPending: Boolean(pendingPayout),
                pendingPayout: pendingPayout ? {
                    _id: pendingPayout._id,
                    netAmount: pendingPayout.netAmount,
                    grossAmount: pendingPayout.grossAmount,
                    payoutMonth: pendingPayout.payoutMonth,
                    createdAt: pendingPayout.createdAt,
                } : null,
                withdrawableBalance: wallet ? wallet.balance : 0,
                allPayouts: (allPayouts || []).map(p => ({
                    _id: p._id,
                    netAmount: p.netAmount,
                    grossAmount: p.grossAmount,
                    payoutMonth: p.payoutMonth,
                    status: p.status,
                    createdAt: p.createdAt,
                    completedAt: p.completedAt,
                })),
            }
        });
    } catch (error) {
        console.error('Creator profile error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/creator/:id/studio
 * All content (public + private + removed) for a creator. Admin sees everything.
 */
export const getCreatorStudio = async (req, res) => {
    try {
        const { id } = req.params;
        const { page = 1, limit = 20, contentType, status, sort, search } = req.query;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid creator ID' });
        }

        const filter = { userId: new mongoose.Types.ObjectId(id) };
        if (contentType) filter.contentType = contentType;
        if (status) filter.status = status;
        if (search) {
            filter.title = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        let sortObj = { createdAt: -1 };
        let needsAggregation = false;
        
        if (sort === 'watchTime') sortObj = { totalWatchTime: -1 };
        else if (sort === 'duration') sortObj = { duration: -1 };
        else if (sort === 'views') sortObj = { views: -1 };
        else if (sort === 'engagement') needsAggregation = true;
        else if (sort === 'completionRate') sortObj = { completionRate: -1 };
        else if (sort === 'ppvPrice') {
            filter.visibility = 'pay_per_view';
            sortObj = { price: -1 };
        } else if (sort === 'ppvEarnings') needsAggregation = true;

        let contents, total;
        
        if (needsAggregation) {
            const pipeline = [{ $match: filter }];
            if (sort === 'engagement') {
                pipeline.push({ $addFields: { totalEngagement: { $add: [{ $ifNull: ['$likeCount', 0] }, { $ifNull: ['$shareCount', 0] }] } } });
                pipeline.push({ $sort: { totalEngagement: -1 } });
            } else if (sort === 'ppvEarnings') {
                filter.visibility = 'pay_per_view';
                pipeline[0] = { $match: filter };
                pipeline.push({
                    $lookup: {
                        from: 'purchases',
                        localField: '_id',
                        foreignField: 'contentId',
                        as: 'purchases'
                    }
                });
                pipeline.push({
                    $addFields: {
                        ppvRevenueRaw: { $sum: '$purchases.creatorPayout' }
                    }
                });
                pipeline.push({ $sort: { ppvRevenueRaw: -1 } });
            }
            
            pipeline.push({ $skip: skip }, { $limit: parseInt(limit) });
            
            [contents, total] = await Promise.all([
                Content.aggregate(pipeline),
                Content.countDocuments(filter)
            ]);
        } else {
            [contents, total] = await Promise.all([
                Content.find(filter)
                    .sort(sortObj)
                    .skip(skip)
                    .limit(parseInt(limit))
                    .lean(),
                Content.countDocuments(filter)
            ]);
        }

        // PPV Revenue aggregation for individual items
        const ppvContentIds = contents.filter(c => c.visibility === 'pay_per_view').map(c => c._id);
        let ppvRevenueMap = {};
        if (ppvContentIds.length > 0) {
            const revAgg = await Purchase.aggregate([
                { $match: { contentId: { $in: ppvContentIds }, status: { $in: ['active', 'expired'] } } },
                { $group: { _id: '$contentId', revenue: { $sum: '$creatorPayout' } } }
            ]);
            ppvRevenueMap = Object.fromEntries(revAgg.map(r => [r._id.toString(), r.revenue]));
        }

        // Check archive status for removed content
        const removedIds = contents.filter(c => c.status === 'removed').map(c => c._id);
        let archiveMap = {};
        if (removedIds.length) {
            const archives = await ContentArchive.find({ content_id: { $in: removedIds }, permanently_deleted: false });
            archiveMap = Object.fromEntries(archives.map(a => [a.content_id.toString(), a]));
        }

        // Fetch comments count for all content
        const allContentIds = contents.map(c => c._id);
        const commentCounts = await Comment.aggregate([
            { $match: { contentId: { $in: allContentIds } } },
            { $group: { _id: '$contentId', count: { $sum: 1 } } }
        ]);
        const commentMap = Object.fromEntries(commentCounts.map(c => [c._id.toString(), c.count]));

        const enrichedContents = contents.map(c => ({
            ...c,
            archive: archiveMap[c._id.toString()] || null,
            ppvRevenue: ppvRevenueMap[c._id.toString()] || 0,
            commentCount: commentMap[c._id.toString()] || 0
        }));

        return res.status(200).json({
            success: true,
            contents: enrichedContents,
            pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('Creator studio error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/creator/:id/ban
 * SuperAdmin: Ban a channel completely. Hides all content, marks user as banned.
 */
export const banChannel = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid creator ID' });
        }

        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.channelBanned) {
            return res.status(400).json({ success: false, message: 'Channel is already banned' });
        }

        // Ban the user
        user.channelBanned = true;
        user.channelBannedAt = new Date();
        user.channelBanReason = reason || 'Banned by SuperAdmin';
        await user.save();

        // Hide all their content: store previousVisibility so unban restores original state
        const userContents = await Content.find({ userId: id, status: 'completed' });
        for (const c of userContents) {
            c.status = 'removed';
            c.previousVisibility = c.visibility;
            await c.save();
        }

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'channel_ban',
            target_type: 'user',
            target_id: id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: reason || 'Channel banned'
        });

        await AdminNotification.create({
            type: 'channel_banned',
            title: 'Channel Banned',
            message: `Channel "${user.channelName || user.userName}" banned by ${req.admin.name}.`,
            severity: 'critical',
            metadata: { user_id: id, admin_id: req.admin._id }
        });

        // Auto-email creator about ban (non-blocking)
        if (user.contact && user.contact.includes('@')) {
            sendAdminEmail('channelBanned', user.contact, {
                creatorName: user.channelName || user.userName || 'Creator',
                reason: reason || '',
                adminName: req.admin.name || 'Admin'
            }).catch(err => console.error('[AdminEmail] Failed to send ban email:', err.message));
        }

        return res.status(200).json({
            success: true,
            message: 'Channel banned successfully. All content hidden.'
        });
    } catch (error) {
        console.error('Ban channel error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/creator/:id/unban
 * SuperAdmin: Unban a channel. Restores content visibility.
 */
export const unbanChannel = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.channelBanned) {
            return res.status(400).json({ success: false, message: 'Channel is not banned' });
        }

        user.channelBanned = false;
        user.channelBannedAt = null;
        user.channelBanReason = null;
        await user.save();

        // Restore content that was hidden by the ban (only 'removed' status)
        await Content.updateMany(
            { userId: id, status: 'removed' },
            { $set: { visibility: 'public', status: 'completed' } }
        );

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'channel_unban',
            target_type: 'user',
            target_id: id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: 'Channel unbanned'
        });

        // Auto-email creator about unban (non-blocking)
        if (user.contact && user.contact.includes('@')) {
            sendAdminEmail('channelUnbanned', user.contact, {
                creatorName: user.channelName || user.userName || 'Creator',
                adminName: req.admin.name || 'Admin'
            }).catch(err => console.error('[AdminEmail] Failed to send unban email:', err.message));
        }

        return res.status(200).json({
            success: true,
            message: 'Channel unbanned. Content restored to public.'
        });
    } catch (error) {
        console.error('Unban channel error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/creator/:id/ban-request
 * Admin requests SuperAdmin to ban a channel.
 */
export const requestBanChannel = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid creator ID' });
        }

        if (!reason || reason.trim().length < 5) {
            return res.status(400).json({ success: false, message: 'Reason is required (at least 5 characters)' });
        }

        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.channelBanned) {
            return res.status(400).json({ success: false, message: 'Channel is already banned' });
        }

        // Check for existing pending ban request
        const existingRequest = await AdminNotification.findOne({
            type: 'ban_request',
            'metadata.user_id': id,
            'metadata.status': 'pending'
        });
        if (existingRequest) {
            return res.status(400).json({ success: false, message: 'A ban request for this channel is already pending' });
        }

        await AdminNotification.create({
            type: 'ban_request',
            title: 'Channel Ban Request',
            message: `Admin "${req.admin.name}" requests ban for channel "${user.channelName || user.userName}". Reason: ${reason.trim()}`,
            severity: 'warning',
            metadata: {
                user_id: id,
                requested_by: req.admin._id,
                reason: reason.trim(),
                status: 'pending'
            }
        });

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'ban_request',
            target_type: 'user',
            target_id: id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: reason.trim()
        });

        return res.status(200).json({
            success: true,
            message: 'Ban request sent to SuperAdmin for review'
        });
    } catch (error) {
        console.error('Ban request error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * PATCH /admin/content/:id/stats
 * SuperAdmin: Update content viewcount and totalWatchTime.
 */
export const updateContentStats = async (req, res) => {
    try {
        const { id } = req.params;
        const { views, totalWatchTime, likeCount } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid content ID' });
        }

        const content = await Content.findById(id);
        if (!content) {
            return res.status(404).json({ success: false, message: 'Content not found' });
        }

        const updates = {};
        if (views !== undefined) {
            const parsed = parseInt(views, 10);
            if (isNaN(parsed) || parsed < 0) {
                return res.status(400).json({ success: false, message: 'Views must be a non-negative integer' });
            }
            updates.views = parsed;
            content.views = parsed;
        }
        if (totalWatchTime !== undefined) {
            const parsed = parseFloat(totalWatchTime);
            if (isNaN(parsed) || parsed < 0) {
                return res.status(400).json({ success: false, message: 'Total watch time must be a non-negative number' });
            }
            updates.totalWatchTime = parsed;
            content.totalWatchTime = parsed;
        }
        if (likeCount !== undefined) {
            const parsed = parseInt(likeCount, 10);
            if (isNaN(parsed) || parsed < 0) {
                return res.status(400).json({ success: false, message: 'Like count must be a non-negative integer' });
            }
            updates.likeCount = parsed;
            content.likeCount = parsed;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, message: 'No valid fields to update' });
        }

        await content.save();

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'stats_update',
            target_type: 'content',
            target_id: content._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: `Updated content stats: ${JSON.stringify(updates)}`
        });

        return res.status(200).json({
            success: true,
            message: 'Content stats updated',
            updates
        });
    } catch (error) {
        console.error('Update content stats error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * PATCH /admin/creator/:id/stats
 * SuperAdmin: Update creator subscriberCount and totalWatchTime.
 */
export const updateCreatorStats = async (req, res) => {
    try {
        const { id } = req.params;
        const { subscriberCount, totalWatchTime, totalViews, totalLikes, uniqueViewers } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid creator ID' });
        }

        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Creator not found' });
        }

        const updates = {};

        if (subscriberCount !== undefined) {
            const parsed = parseInt(subscriberCount, 10);
            if (isNaN(parsed) || parsed < 0) {
                return res.status(400).json({ success: false, message: 'Subscriber count must be a non-negative integer' });
            }
            user.subscriberCountOverride = parsed;
            updates.subscriberCount = parsed;
        }

        const contentList = await Content.find({ userId: id, status: { $ne: 'removed' } });

        if (totalViews !== undefined) {
            const parsed = parseInt(totalViews, 10);
            if (isNaN(parsed) || parsed < 0) {
                return res.status(400).json({ success: false, message: 'Total views must be a non-negative integer' });
            }
            updates.totalViews = parsed;
            // Distribute views proportionally across content
            const currentTotal = contentList.reduce((sum, c) => sum + (c.views || 0), 0);
            if (contentList.length > 0 && currentTotal > 0) {
                const ratio = parsed / currentTotal;
                for (const c of contentList) {
                    c.views = Math.round((c.views || 0) * ratio);
                    await c.save();
                }
            } else if (contentList.length > 0) {
                const perContent = Math.round(parsed / contentList.length);
                for (const c of contentList) {
                    c.views = perContent;
                    await c.save();
                }
            }
        }

        if (totalLikes !== undefined) {
            const parsed = parseInt(totalLikes, 10);
            if (isNaN(parsed) || parsed < 0) {
                return res.status(400).json({ success: false, message: 'Total likes must be a non-negative integer' });
            }
            updates.totalLikes = parsed;
            // Distribute likes proportionally across content
            const currentTotal = contentList.reduce((sum, c) => sum + (c.likeCount || 0), 0);
            if (contentList.length > 0 && currentTotal > 0) {
                const ratio = parsed / currentTotal;
                for (const c of contentList) {
                    c.likeCount = Math.round((c.likeCount || 0) * ratio);
                    await c.save();
                }
            } else if (contentList.length > 0) {
                const perContent = Math.round(parsed / contentList.length);
                for (const c of contentList) {
                    c.likeCount = perContent;
                    await c.save();
                }
            }
        }

        if (totalWatchTime !== undefined) {
            const parsed = parseFloat(totalWatchTime);
            if (isNaN(parsed) || parsed < 0) {
                return res.status(400).json({ success: false, message: 'Total watch time must be a non-negative number' });
            }
            updates.totalWatchTime = parsed;
            // Update the aggregate totalWatchTime on all content by the creator
            const currentTotal = contentList.reduce((sum, c) => sum + (c.totalWatchTime || 0), 0);
            if (contentList.length > 0 && currentTotal > 0) {
                // Scale proportionally
                const ratio = parsed / currentTotal;
                for (const c of contentList) {
                    c.totalWatchTime = Math.round((c.totalWatchTime || 0) * ratio);
                    // Auto-update averageWatchTime: totalWatchTime / views (or 0 if no views)
                    c.averageWatchTime = c.views > 0 ? Math.round(c.totalWatchTime / c.views) : 0;
                    await c.save();
                }
            } else if (contentList.length > 0) {
                // Distribute evenly
                const perContent = Math.round(parsed / contentList.length);
                for (const c of contentList) {
                    c.totalWatchTime = perContent;
                    c.averageWatchTime = c.views > 0 ? Math.round(perContent / c.views) : 0;
                    await c.save();
                }
            }
            // Calculate new average watch time across all content
            const totalViewsNow = contentList.reduce((sum, c) => sum + (c.views || 0), 0);
            updates.avgWatchTime = totalViewsNow > 0 ? Math.round(parsed / totalViewsNow) : 0;
        }

        if (uniqueViewers !== undefined) {
            const parsed = parseInt(uniqueViewers, 10);
            if (isNaN(parsed) || parsed < 0) {
                return res.status(400).json({ success: false, message: 'Unique viewers must be a non-negative integer' });
            }
            updates.uniqueViewers = parsed;
            // Note: uniqueViewers is computed from ContentView documents.
            // We store the override value and return it in analytics.
            user.uniqueViewersOverride = parsed;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, message: 'No valid fields to update' });
        }

        await user.save();

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'stats_update',
            target_type: 'user',
            target_id: user._id,
            ip: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
            note: `Updated creator stats: ${JSON.stringify(updates)}`
        });

        return res.status(200).json({
            success: true,
            message: 'Creator stats updated',
            updates
        });
    } catch (error) {
        console.error('Update creator stats error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/ppv/list
 * Admin PPV management page with views, watch time, completion rate %, revenue, unlock count, creator fan count & filters.
 */
export const listPpvContent = async (req, res) => {
    try {
        const { search, sort = 'popular', page = 1, limit = 20 } = req.query;
        const pageNum = Math.max(1, parseInt(page, 10));
        const limitNum = Math.max(1, parseInt(limit, 10));

        const ppvMatchCondition = {
            $or: [
                { isPayPerView: true },
                { visibility: 'pay_per_view' },
                { ppvPrice: { $gt: 0 } },
                { rentalPrice: { $gt: 0 } },
                { price: { $gt: 0 } }
            ]
        };

        let match = { ...ppvMatchCondition };

        // Search filter (video title/description or creator)
        if (search) {
            const regex = new RegExp(search.trim(), 'i');
            const creatorMatches = await User.find({
                $or: [{ channelName: regex }, { userName: regex }, { channelHandle: regex }]
            }).select('_id').lean();
            const creatorIds = creatorMatches.map(c => c._id);

            match = {
                $and: [
                    ppvMatchCondition,
                    {
                        $or: [
                            { title: regex },
                            { description: regex },
                            { tags: regex },
                            { userId: { $in: creatorIds } }
                        ]
                    }
                ]
            };
        }

        // Aggregate PPV content with Purchase revenue and Creator details
        const pipeline = [
            { $match: match },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'creator'
                }
            },
            { $unwind: { path: '$creator', preserveNullAndEmptyArrays: true } },
            // Lookup subscriber count for the creator
            {
                $lookup: {
                    from: 'users',
                    let: { creatorId: '$creator._id' },
                    pipeline: [
                        { $match: { $expr: { $in: ['$$creatorId', { $ifNull: ['$subscriptions', []] }] } } },
                        { $count: 'n' }
                    ],
                    as: '_creatorFollowers'
                }
            },
            {
                $lookup: {
                    from: 'purchases',
                    let: { contentId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$contentId', '$$contentId'] },
                                        { $in: ['$status', ['active', 'expired']] }
                                    ]
                                }
                            }
                        },
                        {
                            $group: {
                                _id: null,
                                totalRevenue: { $sum: '$amount' },
                                totalUnlocks: { $sum: 1 }
                            }
                        }
                    ],
                    as: 'purchaseStats'
                }
            },
            { $unwind: { path: '$purchaseStats', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 1,
                    title: 1,
                    description: 1,
                    thumbnailUrl: 1,
                    thumbnailKey: 1,
                    imageKey: 1,
                    processedKey: 1,
                    hlsMasterKey: 1,
                    originalKey: 1,
                    videoUrl: 1,
                    duration: 1,
                    completionRate: 1,
                    furthestPlayheadSeconds: 1,
                    viewsCount: { $ifNull: ['$viewsCount', { $ifNull: ['$views', 0] }] },
                    watchTime: { $ifNull: ['$watchTime', { $ifNull: ['$totalWatchTime', 0] }] },
                    likeCount: { $ifNull: ['$likeCount', 0] },
                    ppvPrice: 1,
                    rentalPrice: 1,
                    price: 1,
                    rentalValidityDays: 1,
                    createdAt: 1,
                    visibility: 1,
                    status: 1,
                    contentType: 1,
                    creator: {
                        _id: '$creator._id',
                        channelName: '$creator.channelName',
                        userName: '$creator.userName',
                        channelHandle: '$creator.channelHandle',
                        channelPicture: '$creator.channelPicture',
                        subscriberCount: {
                            $ifNull: [
                                '$creator.subscriberCountOverride',
                                { $ifNull: [{ $arrayElemAt: ['$_creatorFollowers.n', 0] }, 0] }
                            ]
                        }
                    },
                    totalRevenue: { $ifNull: ['$purchaseStats.totalRevenue', 0] },
                    totalUnlocks: { $ifNull: ['$purchaseStats.totalUnlocks', 0] }
                }
            }
        ];

        // Sort options
        const sortStage = {};
        if (sort === 'newest') sortStage.createdAt = -1;
        else if (sort === 'oldest') sortStage.createdAt = 1;
        else if (sort === 'watchTime') sortStage.watchTime = -1;
        else if (sort === 'fans') sortStage['creator.subscriberCount'] = -1;
        else if (sort === 'revenue') sortStage.totalRevenue = -1;
        else sortStage.viewsCount = -1;

        pipeline.push({ $sort: sortStage });

        // Facet for pagination
        pipeline.push({
            $facet: {
                data: [{ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum }],
                totalCount: [{ $count: 'count' }]
            }
        });

        const aggregateResult = await Content.aggregate(pipeline);
        const rawItems = aggregateResult[0]?.data || [];
        const total = aggregateResult[0]?.totalCount[0]?.count || 0;

        const items = rawItems.map((item) => {
            const mediaKey = item.processedKey || item.originalKey;
            const thumbKey = item.thumbnailKey || item.imageKey || item.thumbnailUrl;

            const views = Number(item.viewsCount || 0);
            const watchSec = Number(item.watchTime || 0);
            const durSec = Number(item.duration || 0);

            const rawComp = item.completionRate;
            const furthestSec = Number(item.furthestPlayheadSeconds || 0);
            let completionRate = 0;
            if (rawComp !== null && rawComp !== undefined) {
                completionRate = Math.min(100, Math.round(rawComp));
            } else if (durSec > 0 && furthestSec > 0) {
                completionRate = Math.min(100, Math.round((furthestSec / durSec) * 100));
            }

            return {
                ...item,
                viewsCount: views,
                watchTime: watchSec,
                completionRate,
                ppvPrice: item.ppvPrice || item.price || item.rentalPrice || 0,
                thumbnailUrl: getCfUrl(thumbKey),
                videoUrl: mediaKey ? getCfUrl(mediaKey) : null,
                hlsMasterUrl: item.hlsMasterKey ? getCfHlsMasterUrl(item.hlsMasterKey) : null,
                creator: item.creator ? {
                    ...item.creator,
                    channelPicture: getCfUrl(item.creator.channelPicture)
                } : null
            };
        });

        if (sort === 'completionRate') {
            items.sort((a, b) => b.completionRate - a.completionRate);
        }

        // Summary metrics across all PPV content
        const summaryAgg = await Content.aggregate([
            { $match: ppvMatchCondition },
            {
                $group: {
                    _id: null,
                    totalPpvCount: { $sum: 1 },
                    totalViews: { $sum: { $ifNull: ['$viewsCount', { $ifNull: ['$views', 0] }] } },
                    totalWatchTime: { $sum: { $ifNull: ['$watchTime', { $ifNull: ['$totalWatchTime', 0] }] } }
                }
            }
        ]);


        const summary = summaryAgg[0] || { totalPpvCount: 0, totalViews: 0, totalWatchTime: 0 };

        return res.status(200).json({
            success: true,
            ppvItems: items,
            summary: {
                totalPpvCount: summary.totalPpvCount,
                totalViews: summary.totalViews,
                totalWatchTime: summary.totalWatchTime
            },
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                pages: Math.ceil(total / limitNum)
            }
        });
    } catch (err) {
        console.error('Error fetching PPV content for admin:', err);
        return res.status(500).json({ success: false, message: err.message || 'Server error fetching PPV content' });
    }
};

/**
 * GET /admin/content/list
 * Returns ALL platform content with rich filtering, sorting, and search.
 * Query params: page, limit, status, visibility, contentType, sort, search
 */
export const listAllContent = async (req, res) => {
    try {
        const { page = 1, limit = 20, status, visibility, contentType, sort = 'newest', search } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const filter = {};
        if (status) filter.status = status;
        if (visibility) filter.visibility = visibility;
        if (contentType) filter.contentType = contentType;
        if (search) {
            filter.title = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }

        let needsAggregation = false;
        let sortObj = { createdAt: -1 };

        if (sort === 'oldest') sortObj = { createdAt: 1 };
        else if (sort === 'views') sortObj = { views: -1 };
        else if (sort === 'watchTime') sortObj = { totalWatchTime: -1 };
        else if (sort === 'completionRate') sortObj = { completionRate: -1 };
        else if (sort === 'duration') sortObj = { duration: -1 };
        else if (sort === 'ppvPrice') {
            filter.visibility = 'pay_per_view';
            sortObj = { price: -1 };
        } else if (sort === 'interactions' || sort === 'creatorFans' || sort === 'revenue' || sort === 'mostEarned') {
            needsAggregation = true;
        }

        let contents, total;

        if (needsAggregation) {
            const pipeline = [{ $match: filter }];
            
            if (sort === 'interactions') {
                pipeline.push({ $addFields: { interactions: { $add: [{ $ifNull: ['$likeCount', 0] }, { $ifNull: ['$shareCount', 0] }] } } });
                pipeline.push({ $sort: { interactions: -1 } });
            } else if (sort === 'creatorFans') {
                pipeline.push({
                    $lookup: {
                        from: 'users',
                        localField: 'userId',
                        foreignField: '_id',
                        as: 'creator'
                    }
                });
                pipeline.push({ $unwind: { path: '$creator', preserveNullAndEmptyArrays: true } });
                pipeline.push({ $sort: { 'creator.subscriberCount': -1 } });
            } else if (sort === 'revenue' || sort === 'mostEarned') {
                filter.visibility = 'pay_per_view';
                pipeline[0] = { $match: filter }; // update match
                pipeline.push({
                    $lookup: {
                        from: 'purchases',
                        localField: '_id',
                        foreignField: 'contentId',
                        as: 'purchases'
                    }
                });
                pipeline.push({
                    $addFields: {
                        ppvRevenueRaw: { $sum: '$purchases.creatorPayout' }
                    }
                });
                pipeline.push({ $sort: { ppvRevenueRaw: -1 } });
            }
            
            pipeline.push({ $skip: skip }, { $limit: parseInt(limit) });

            [contents, total] = await Promise.all([
                Content.aggregate(pipeline),
                Content.countDocuments(filter)
            ]);
            
            // Re-populate creator if not already done in aggregation
            if (sort !== 'creatorFans') {
                await Content.populate(contents, { path: 'userId', select: 'userName channelName channelHandle channelPicture subscriberCount' });
            } else {
                contents = contents.map(c => {
                    c.userId = c.creator;
                    delete c.creator;
                    return c;
                });
            }
        } else {
            [contents, total] = await Promise.all([
                Content.find(filter)
                    .sort(sortObj)
                    .skip(skip)
                    .limit(parseInt(limit))
                    .populate('userId', 'userName channelName channelHandle channelPicture subscriberCount')
                    .lean(),
                Content.countDocuments(filter)
            ]);
        }

        const contentIds = contents.map(c => c._id);

        // Fetch counts for each content
        const [commentCounts, purchaseAgg] = await Promise.all([
            Comment.aggregate([
                { $match: { contentId: { $in: contentIds } } },
                { $group: { _id: '$contentId', count: { $sum: 1 } } }
            ]),
            Purchase.aggregate([
                { $match: { contentId: { $in: contentIds }, status: { $in: ['active', 'expired'] } } },
                { $group: { _id: '$contentId', purchases: { $sum: 1 }, revenue: { $sum: '$creatorPayout' } } }
            ])
        ]);

        const commentMap = Object.fromEntries(commentCounts.map(c => [c._id.toString(), c.count]));
        const purchaseMap = Object.fromEntries(purchaseAgg.map(p => [p._id.toString(), { count: p.purchases, revenue: p.revenue }]));

        // Auto-remedy any existing PPV content that has price > 0 but visibility set to public (due to past unban bug)
        await Content.updateMany(
            { price: { $gt: 0 }, visibility: 'public', status: 'completed' },
            { $set: { visibility: 'pay_per_view' } }
        );

        const enrichedContents = contents.map(c => {
            const cId = c._id.toString();
            const thumbKey = c.thumbnailKey || c.imageKey || c.thumbnailUrl || c.thumbnail;
            const mediaKey = c.processedKey || c.originalKey || c.hlsKey || c.mediaKey || c.videoKey || c.s3Key;
            const pInfo = purchaseMap[cId] || { count: 0, revenue: 0 };
            const uInfo = c.userId || {};
            
            let videoUrl = null;
            let audioUrl = null;
            let imageUrls = [];

            if (c.contentType === 'short' || c.contentType === 'video') {
                videoUrl = mediaKey ? getCfUrl(mediaKey) : (c.videoUrl || c.mediaUrl || null);
            } else if (c.contentType === 'audio') {
                audioUrl = mediaKey ? getCfUrl(mediaKey) : (c.audioUrl || c.mediaUrl || null);
            } else if (c.contentType === 'post') {
                if (c.imageKeys && c.imageKeys.length > 0) {
                    imageUrls = c.imageKeys.map(k => getCfUrl(k)).filter(Boolean);
                } else if (c.imageKey) {
                    imageUrls = [getCfUrl(c.imageKey)].filter(Boolean);
                }
            }

            return {
                ...c,
                thumbnailUrl: getCfUrl(thumbKey),
                videoUrl,
                audioUrl,
                imageUrls,
                hlsMasterUrl: c.hlsMasterKey ? getCfHlsMasterUrl(c.hlsMasterKey) : null,
                creator: {
                    userName: uInfo.userName,
                    channelName: uInfo.channelName,
                    channelHandle: uInfo.channelHandle,
                    subscriberCount: uInfo.subscriberCount || 0,
                    channelPicture: getCfUrl(uInfo.channelPicture || uInfo.profilePicture)
                },
                commentCount: commentMap[cId] || 0,
                purchaseCount: pInfo.count,
                ppvRevenue: pInfo.revenue
            };
        });

        // Summary Stats
        const statsAgg = await Content.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: null,
                    totalCount: { $sum: 1 },
                    totalViews: { $sum: '$views' },
                    totalWatchTime: { $sum: '$totalWatchTime' },
                    uploading: { $sum: { $cond: [{ $eq: ['$status', 'uploading'] }, 1, 0] } },
                    processing: { $sum: { $cond: [{ $eq: ['$status', 'processing'] }, 1, 0] } },
                    completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                    failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
                    removed: { $sum: { $cond: [{ $eq: ['$status', 'removed'] }, 1, 0] } },
                    ppvCount: { $sum: { $cond: [{ $eq: ['$visibility', 'pay_per_view'] }, 1, 0] } }
                }
            }
        ]);
        
        const overallPpvRevAgg = await Content.aggregate([
            { $match: filter },
            {
                $lookup: {
                    from: 'purchases',
                    localField: '_id',
                    foreignField: 'contentId',
                    as: 'purchases'
                }
            },
            { $unwind: '$purchases' },
            { $match: { 'purchases.status': { $in: ['active', 'expired'] } } },
            {
                $group: {
                    _id: null,
                    totalPpvRevenue: { $sum: '$purchases.creatorPayout' }
                }
            }
        ]);

        const stats = statsAgg[0] || { totalCount: 0, totalViews: 0, totalWatchTime: 0, uploading: 0, processing: 0, completed: 0, failed: 0, removed: 0, ppvCount: 0 };
        const totalPpvRevenue = overallPpvRevAgg[0] ? overallPpvRevAgg[0].totalPpvRevenue : 0;

        return res.status(200).json({
            success: true,
            contents: enrichedContents,
            summary: {
                totalCount: stats.totalCount,
                totalViews: stats.totalViews,
                totalWatchTime: stats.totalWatchTime,
                statusBreakdown: {
                    uploading: stats.uploading,
                    processing: stats.processing,
                    completed: stats.completed,
                    failed: stats.failed,
                    removed: stats.removed
                },
                ppvCount: stats.ppvCount,
                totalPpvRevenue
            },
            pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('List all content error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/content/:id/detailed-analytics
 * Returns deep analytics for a specific content item.
 */
export const getContentDetailedAnalytics = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid content ID' });
        }

        const content = await Content.findById(id).populate('userId', 'userName channelName channelHandle channelPicture subscriberCount').lean();
        if (!content) {
            return res.status(404).json({ success: false, message: 'Content not found' });
        }

        const thumbKey = content.thumbnailKey || content.imageKey || content.thumbnailUrl || content.thumbnail;
        content.thumbnailUrl = getCfUrl(thumbKey);

        const mediaKey = content.processedKey || content.originalKey || content.hlsKey || content.mediaKey || content.videoKey || content.s3Key;
        if (content.hlsMasterKey) {
            content.hlsMasterUrl = getCfHlsMasterUrl(content.hlsMasterKey);
        }
        if (content.contentType === 'short' || content.contentType === 'video') {
            content.videoUrl = mediaKey ? getCfUrl(mediaKey) : (content.videoUrl || content.mediaUrl || null);
        } else if (content.contentType === 'audio') {
            content.audioUrl = mediaKey ? getCfUrl(mediaKey) : (content.audioUrl || content.mediaUrl || null);
        } else if (content.contentType === 'post') {
            if (content.imageKeys && content.imageKeys.length > 0) {
                content.imageUrls = content.imageKeys.map(k => getCfUrl(k)).filter(Boolean);
            } else if (content.imageKey) {
                content.imageUrls = [getCfUrl(content.imageKey)].filter(Boolean);
            }
        }

        if (content.userId) {
            content.userId.channelPicture = getCfUrl(content.userId.channelPicture || content.userId.profilePicture);
        }

        // Daily views over last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const viewsAgg = await ContentView.aggregate([
            { $match: { contentId: new mongoose.Types.ObjectId(id), firstViewedAt: { $gte: thirtyDaysAgo } } },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$firstViewedAt" } },
                    views: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        const peakHoursAgg = await ContentView.aggregate([
            { $match: { contentId: new mongoose.Types.ObjectId(id) } },
            {
                $group: {
                    _id: { $hour: "$firstViewedAt" },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        const totalComments = await Comment.countDocuments({ contentId: id });
        const likeToViewRatio = content.views > 0 ? ((content.likeCount || 0) / content.views) : 0;

        const engagementMetrics = {
            totalLikes: content.likeCount || 0,
            totalDislikes: content.dislikeCount || 0,
            totalShares: content.shareCount || 0,
            totalComments,
            likeToViewRatio
        };

        const watchHistories = await WatchHistory.aggregate([
            { $match: { contentId: new mongoose.Types.ObjectId(id) } },
            {
                $group: {
                    _id: null,
                    sumPercent: { $sum: '$completionPercentage' },
                    count: { $sum: 1 }
                }
            }
        ]);
        const completionSessionCount = watchHistories[0] ? watchHistories[0].count : 0;
        const completionSumPercent = watchHistories[0] ? watchHistories[0].sumPercent : 0;
        const avgCompletion = completionSessionCount > 0 ? (completionSumPercent / completionSessionCount) : 0;

        const completionData = {
            avgCompletion,
            completionRate: content.completionRate || 0,
            completionSumPercent,
            completionSessionCount
        };

        let ppvEarnings = null;
        let buyers = 0;
        
        if (content.visibility === 'pay_per_view') {
            const pAgg = await Purchase.aggregate([
                { $match: { contentId: new mongoose.Types.ObjectId(id), status: { $in: ['active', 'expired'] } } },
                {
                    $group: {
                        _id: null,
                        totalRevenue: { $sum: '$creatorPayout' },
                        totalPurchases: { $sum: 1 },
                        avgPrice: { $avg: '$amount' },
                        uniqueBuyers: { $addToSet: '$userId' }
                    }
                }
            ]);

            const pOverTime = await Purchase.aggregate([
                { $match: { contentId: new mongoose.Types.ObjectId(id), status: { $in: ['active', 'expired'] }, purchasedAt: { $gte: thirtyDaysAgo } } },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$purchasedAt" } },
                        revenue: { $sum: '$creatorPayout' }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            if (pAgg.length > 0) {
                ppvEarnings = {
                    totalRevenue: pAgg[0].totalRevenue,
                    totalPurchases: pAgg[0].totalPurchases,
                    avgPrice: pAgg[0].avgPrice,
                    earningsOverTime: pOverTime
                };
                buyers = pAgg[0].uniqueBuyers.length;
            } else {
                ppvEarnings = { totalRevenue: 0, totalPurchases: 0, avgPrice: 0, earningsOverTime: [] };
            }
        }

        return res.status(200).json({
            success: true,
            content,
            viewsOverTime: viewsAgg,
            peakViewingHours: peakHoursAgg,
            engagementMetrics,
            completionData,
            ppvEarnings: content.visibility === 'pay_per_view' ? ppvEarnings : null,
            buyers: content.visibility === 'pay_per_view' ? buyers : null
        });
    } catch (error) {
        console.error('Content detailed analytics error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
