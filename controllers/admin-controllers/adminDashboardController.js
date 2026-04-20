import Content from '../../models/content.model.js';
import ContentReport from '../../models/contentReport.model.js';
import Feedback from '../../models/contact.feedback.model.js';
import Enquiry from '../../models/contact.enquiry.model.js';
import AdminAuditLog from '../../models/adminAuditLog.model.js';
import AdminNotification from '../../models/adminNotification.model.js';
import ContentArchive from '../../models/contentArchive.model.js';
import User from '../../models/user.model.js';
import Admin from '../../models/admin.model.js';
import AdminRequest from '../../models/adminRequest.model.js';
import WatchHistory from '../../models/watchHistory.model.js';

/**
 * GET /admin/dashboard
 * Returns top-line dashboard metadata.
 */
export const getDashboard = async (req, res) => {
    try {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000);

        const [
            totalContent,
            totalCreators,
            pendingReports,
            totalFeedback,
            totalEnquiries,
            archivedContentCount,
            recentLogins,
            todayViews,
            pendingAdminRequests,
            totalAdmins,
            latestReports,
            latestFeedback,
            latestEnquiries,
            notifications,
            contentUploading,
            contentProcessing,
            contentFailed,
            contentCompleted,
            activeUsersResult
        ] = await Promise.all([
            Content.countDocuments({ status: 'completed' }),
            User.countDocuments({}),
            ContentReport.countDocuments({ status: 'pending' }),
            Feedback.countDocuments({}),
            Enquiry.countDocuments({}),
            ContentArchive.countDocuments({ permanently_deleted: false, restored_at: null }),
            User.countDocuments({ lastLoginAt: { $gte: today } }),
            Content.aggregate([
                { $match: { updatedAt: { $gte: today } } },
                { $group: { _id: null, views: { $sum: '$views' } } }
            ]),
            AdminRequest.countDocuments({ status: 'pending' }),
            Admin.countDocuments({ status: 'active' }),
            ContentReport.find({ status: 'pending' })
                .sort({ createdAt: -1 })
                .limit(5)
                .populate('contentId', 'title contentType')
                .populate('reporterId', 'userName'),
            Feedback.find().sort({ createdAt: -1 }).limit(5).populate('userId', 'userName email'),
            Enquiry.find().sort({ createdAt: -1 }).limit(5),
            AdminNotification.find()
                .sort({ createdAt: -1 })
                .limit(10),
            Content.countDocuments({ status: 'uploading' }),
            Content.countDocuments({ status: 'processing' }),
            Content.countDocuments({ status: 'failed' }),
            Content.countDocuments({ status: 'completed' }),
            // Active users: distinct users with watch activity in last 15 min
            WatchHistory.distinct('userId', { lastWatchedAt: { $gte: fifteenMinAgo } })
        ]);

        return res.status(200).json({
            success: true,
            dashboard: {
                metrics: {
                    totalContent,
                    totalCreators,
                    pendingReports,
                    totalFeedback,
                    archivedContentCount,
                    recentLogins,
                    todayViews: todayViews[0]?.views || 0,
                    pendingAdminRequests,
                    totalAdmins,
                    contentUploading,
                    contentProcessing,
                    contentFailed,
                    contentCompleted,
                    activeUsers: activeUsersResult?.length || 0,
                    totalEnquiries
                },
                latestReports,
                latestFeedback,
                latestEnquiries,
                notifications
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/reports
 * List reports with filters and pagination.
 */
export const listReports = async (req, res) => {
    try {
        const {
            page = 1, limit = 20,
            status, reason, dateFrom, dateTo,
            contentType, sort = 'latest'
        } = req.query;

        const filter = {};
        if (status) filter.status = status;
        if (reason) filter.reason = reason;
        if (dateFrom || dateTo) {
            filter.createdAt = {};
            if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
            if (dateTo) filter.createdAt.$lte = new Date(dateTo);
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const sortObj = sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };

        let pipeline = [
            { $match: filter },
            { $sort: sortObj },
            { $skip: skip },
            { $limit: parseInt(limit) },
            {
                $lookup: {
                    from: 'contents', localField: 'contentId', foreignField: '_id', as: 'content',
                    pipeline: [{ $project: { title: 1, contentType: 1, userId: 1, thumbnailKey: 1 } }]
                }
            },
            { $unwind: { path: '$content', preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: 'users', localField: 'reporterId', foreignField: '_id', as: 'reporter',
                    pipeline: [{ $project: { userName: 1, contact: 1 } }]
                }
            },
            { $unwind: { path: '$reporter', preserveNullAndEmptyArrays: true } }
        ];

        // Add content type filter via lookup
        if (contentType) {
            pipeline.splice(1, 0, {
                $lookup: { from: 'contents', localField: 'contentId', foreignField: '_id', as: '_c' }
            });
            pipeline.splice(2, 0, { $match: { '_c.contentType': contentType } });
            pipeline.splice(3, 0, { $project: { _c: 0 } });
        }

        const [reports, total] = await Promise.all([
            ContentReport.aggregate(pipeline),
            ContentReport.countDocuments(filter)
        ]);

        return res.status(200).json({
            success: true,
            reports,
            pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('List reports error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/reports/:id/resolve
 * Resolve or take down a report.
 * action: 'resolved' | 'takedown'
 * For takedown: justification is required, content is archived with 24h cooldown.
 */
export const resolveReport = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, note, justification } = req.body;

        const report = await ContentReport.findById(id);
        if (!report) {
            return res.status(404).json({ success: false, message: 'Report not found' });
        }

        if (action === 'takedown') {
            if (!justification || justification.trim().length < 10) {
                return res.status(400).json({ success: false, message: 'Takedown requires a justification (at least 10 characters)' });
            }

            const content = await Content.findById(report.contentId);
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
            const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1000;

            // Build HLS prefix for later S3 cleanup
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
                reason: justification.trim()
            });

            // Mark content as removed
            content.status = 'removed';
            content.visibility = 'private';
            await content.save();

            // Mark report as taken down
            report.status = 'resolved';
            report.takenDown = true;
            report.takenDownAt = now;
            report.takedownJustification = justification.trim();
            report.reviewedBy = req.admin._id;
            report.reviewedAt = now;
            await report.save();

            await AdminAuditLog.create({
                admin_id: req.admin._id,
                action: 'report_takedown',
                target_type: 'report',
                target_id: report._id,
                ip: req.ip || '',
                user_agent: req.headers['user-agent'] || '',
                note: justification.trim()
            });

            await AdminNotification.create({
                type: 'content_removed',
                title: 'Content Taken Down',
                message: `"${content.title || 'Untitled'}" taken down via report by ${req.admin.name}. Can be permanently deleted after 24h.`,
                severity: 'warning',
                metadata: { content_id: content._id, report_id: report._id, admin_id: req.admin._id }
            });

            return res.status(200).json({
                success: true,
                message: 'Content archived. Can be permanently deleted after 24 hours.',
                delete_scheduled_at: new Date(now.getTime() + ARCHIVE_TTL_MS)
            });
        }

        // Resolve without takedown
        report.status = 'resolved';
        report.reviewedBy = req.admin._id;
        report.reviewedAt = new Date();
        await report.save();

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'report_resolve',
            target_type: 'report',
            target_id: report._id,
            ip: req.ip || '',
            user_agent: req.headers['user-agent'] || '',
            note: note || ''
        });

        return res.status(200).json({ success: true, message: 'Report resolved' });
    } catch (error) {
        console.error('Resolve report error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/feedbacks
 * List feedbacks with pagination.
 */
export const listFeedbacks = async (req, res) => {
    try {
        const { page = 1, limit = 20, dateFrom, dateTo, sort = 'latest' } = req.query;
        const filter = {};
        if (dateFrom || dateTo) {
            filter.createdAt = {};
            if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
            if (dateTo) filter.createdAt.$lte = new Date(dateTo);
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const sortObj = sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };

        const [feedbacks, total] = await Promise.all([
            Feedback.find(filter).sort(sortObj).skip(skip).limit(parseInt(limit)),
            Feedback.countDocuments(filter)
        ]);

        return res.status(200).json({
            success: true,
            feedbacks,
            pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('List feedbacks error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/enquiries
 * List contact enquiries with pagination.
 */
export const listEnquiries = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [enquiries, total] = await Promise.all([
            Enquiry.find().sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
            Enquiry.countDocuments()
        ]);

        return res.status(200).json({
            success: true,
            enquiries,
            pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('List enquiries error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/audit-logs
 * Filterable audit logs.
 */
export const listAuditLogs = async (req, res) => {
    try {
        const { page = 1, limit = 50, admin_id, action, dateFrom, dateTo, target_type, target_id } = req.query;
        const filter = {};

        if (admin_id) filter.admin_id = admin_id;
        if (action) filter.action = action;
        if (target_type) filter.target_type = target_type;
        if (target_id) filter.target_id = target_id;
        if (dateFrom || dateTo) {
            filter.timestamp = {};
            if (dateFrom) filter.timestamp.$gte = new Date(dateFrom);
            if (dateTo) filter.timestamp.$lte = new Date(dateTo);
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [logs, total] = await Promise.all([
            AdminAuditLog.find(filter)
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .populate('admin_id', 'name contact role'),
            AdminAuditLog.countDocuments(filter)
        ]);

        return res.status(200).json({
            success: true,
            logs,
            pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
        });
    } catch (error) {
        console.error('List audit logs error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/notifications
 * Admin dashboard notifications.
 */
export const listNotifications = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [notifications, total] = await Promise.all([
            AdminNotification.find()
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            AdminNotification.countDocuments()
        ]);

        return res.status(200).json({ success: true, notifications, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
    } catch (error) {
        console.error('List notifications error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/notifications/:id/read
 * Mark notification as read by the current admin.
 */
export const markNotificationRead = async (req, res) => {
    try {
        const { id } = req.params;
        await AdminNotification.findByIdAndUpdate(id, { $addToSet: { read_by: req.admin._id } });
        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/users
 * List all users with sorting, filtering, and engagement data.
 * Query params:
 *   page, limit, sortBy (createdAt | fans | watchtime | removedContent), sortOrder (asc | desc)
 *   search (username/email/handle search), channelStatus (active | banned)
 */
export const listUsers = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            sortBy = 'createdAt',
            sortOrder = 'desc',
            search,
            channelStatus
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Build filter
        let filter = {};
        if (search) {
            const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [
                { userName: regex },
                { contact: regex },
                { channelHandle: regex },
                { channelName: regex },
                { fullName: regex }
            ];
        }
        if (channelStatus === 'banned') {
            filter.channelBanned = true;
        } else if (channelStatus === 'active') {
            filter.channelBanned = { $ne: true };
        }

        // Fetch users
        const [users, total] = await Promise.all([
            User.find(filter)
                .select('userName contact channelName channelHandle profilePicture channelPicture fullName createdAt channelBanned channelBannedAt lastLoginAt subscriptions')
                .sort({ createdAt: sortOrder === 'asc' ? 1 : -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            User.countDocuments(filter)
        ]);

        // Enrich each user with engagement data in parallel
        const enrichedUsers = await Promise.all(users.map(async (user) => {
            const [fanCount, totalContent, removedContentCount, watchHistoryAgg] = await Promise.all([
                User.countDocuments({ subscriptions: user._id }),
                Content.countDocuments({ userId: user._id }),
                Content.countDocuments({ userId: user._id, status: { $in: ['removed', 'hidden'] } }),
                WatchHistory.aggregate([
                    { $match: { userId: user._id } },
                    { $group: { _id: null, totalWatchTime: { $sum: '$watchTime' }, totalWatchCount: { $sum: '$watchCount' } } }
                ])
            ]);

            const watchStats = watchHistoryAgg[0] || { totalWatchTime: 0, totalWatchCount: 0 };

            return {
                _id: user._id,
                userName: user.userName,
                contact: user.contact,
                channelName: user.channelName,
                channelHandle: user.channelHandle,
                profilePicture: user.profilePicture || user.channelPicture,
                fullName: user.fullName,
                createdAt: user.createdAt,
                lastLoginAt: user.lastLoginAt,
                channelBanned: user.channelBanned || false,
                channelBannedAt: user.channelBannedAt,
                fanCount,
                totalContent,
                removedContentCount,
                totalWatchTime: watchStats.totalWatchTime,
                totalWatchCount: watchStats.totalWatchCount,
            };
        }));

        // Sort by computed fields if needed
        if (sortBy === 'fans') {
            enrichedUsers.sort((a, b) => sortOrder === 'asc' ? a.fanCount - b.fanCount : b.fanCount - a.fanCount);
        } else if (sortBy === 'watchtime') {
            enrichedUsers.sort((a, b) => sortOrder === 'asc' ? a.totalWatchTime - b.totalWatchTime : b.totalWatchTime - a.totalWatchTime);
        } else if (sortBy === 'removedContent') {
            enrichedUsers.sort((a, b) => sortOrder === 'asc' ? a.removedContentCount - b.removedContentCount : b.removedContentCount - a.removedContentCount);
        }

        return res.status(200).json({
            success: true,
            users: enrichedUsers,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('List users error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * POST /admin/send-email
 * Send a free-form or templated email to a creator.
 * Body: { creatorId, template, subject, body, reason }
 */
export const adminSendEmailHandler = async (req, res) => {
    try {
        const { creatorId, template, subject, body, reason } = req.body;

        if (!creatorId) {
            return res.status(400).json({ success: false, message: 'creatorId is required' });
        }

        const user = await User.findById(creatorId).select('userName contact channelName').lean();
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.contact || !user.contact.includes('@')) {
            return res.status(400).json({ success: false, message: 'User does not have an email address' });
        }

        const { sendAdminEmail, sendCustomEmail } = await import('../../services/adminEmailService.js');
        const creatorName = user.channelName || user.userName || 'Creator';
        const adminName = req.admin.name || 'Admin';

        let sent = false;
        if (template && template !== 'custom') {
            sent = await sendAdminEmail(template, user.contact, {
                creatorName, reason: reason || body || '',
                warningMessage: body || reason || '',
                adminName, contentTitle: '', contentType: '',
                subject, body: body || '',
            });
        } else {
            if (!subject || !body) {
                return res.status(400).json({ success: false, message: 'Subject and body are required for custom emails' });
            }
            sent = await sendCustomEmail(user.contact, subject, body, creatorName, adminName);
        }

        await AdminAuditLog.create({
            admin_id: req.admin._id,
            action: 'email_sent',
            target_type: 'user',
            target_id: creatorId,
            ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '',
            user_agent: req.headers['user-agent'] || '',
            note: `Email "${template || 'custom'}" sent to ${user.contact}${subject ? ` — Subject: ${subject}` : ''}`
        });

        return res.status(200).json({
            success: true, sent,
            message: sent ? 'Email sent successfully' : 'Email sending failed (check email configuration)'
        });
    } catch (error) {
        console.error('Send email error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

