import User from '../../models/user.model.js';
import Content from '../../models/content.model.js';
import WatchHistory from '../../models/watchHistory.model.js';
import Message from '../../models/message.model.js';
import CommunityChat from '../../models/communityChat.model.js';
import mongoose from 'mongoose';

/**
 * Helper: generate array of dates for last N days (inclusive of today)
 */
function getLastNDays(n) {
    const dates = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        dates.push(d);
    }
    return dates;
}

/**
 * Helper: generate array of months for last N months (inclusive of current)
 */
function getLastNMonths(n) {
    const months = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(d);
    }
    return months;
}

/**
 * GET /admin/analytics
 * Returns comprehensive platform analytics with daily/monthly breakdowns.
 */
export const getAnalytics = async (req, res) => {
    try {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

        // ─── Run all aggregations in parallel ─────────────────────────────
        const [
            // Summary numbers
            totalUsers,
            totalChannels,
            totalUsersWithoutChannel,
            totalWatchTimeResult,
            totalMessagesResult,
            totalCommunityMessagesResult,
            totalContentByType,

            // Daily signups (last 30 days) - use _id ObjectId timestamp
            dailySignups,

            // Monthly signups (last 12 months)
            monthlySignups,

            // Daily watch time (last 30 days)
            dailyWatchTime,

            // Daily logins (last 30 days)
            dailyLogins,

            // Daily messages (last 30 days)
            dailyMessages,

            // Daily content uploads (last 30 days)
            dailyUploads,

            // Content type distribution
            contentByStatus,
        ] = await Promise.all([
            // Total users
            User.countDocuments({}),

            // Total channels (users who have a channelName)
            User.countDocuments({ channelName: { $exists: true, $ne: null, $ne: '' } }),

            // Users without a channel
            User.countDocuments({
                $or: [
                    { channelName: { $exists: false } },
                    { channelName: null },
                    { channelName: '' }
                ]
            }),

            // Total platform watch time (sum of all watchHistory watchTime)
            WatchHistory.aggregate([
                { $group: { _id: null, total: { $sum: '$watchTime' } } }
            ]),

            // Total DM messages
            Message.countDocuments({ deletedForEveryone: { $ne: true } }),

            // Total community messages
            CommunityChat.countDocuments({}),

            // Content count by type
            Content.aggregate([
                { $match: { status: 'completed' } },
                { $group: { _id: '$contentType', count: { $sum: 1 } } }
            ]),

            // Daily signups (last 30 days) — derive createdAt from ObjectId
            User.aggregate([
                {
                    $addFields: {
                        createdDate: { $toDate: '$_id' }
                    }
                },
                {
                    $match: {
                        createdDate: { $gte: thirtyDaysAgo }
                    }
                },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$createdDate' }
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]),

            // Monthly signups (last 12 months)
            User.aggregate([
                {
                    $addFields: {
                        createdDate: { $toDate: '$_id' }
                    }
                },
                {
                    $match: {
                        createdDate: { $gte: twelveMonthsAgo }
                    }
                },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m', date: '$createdDate' }
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]),

            // Daily watch time (last 30 days)
            WatchHistory.aggregate([
                { $match: { lastWatchedAt: { $gte: thirtyDaysAgo } } },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$lastWatchedAt' }
                        },
                        totalWatchTime: { $sum: '$watchTime' },
                        sessions: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]),

            // Daily logins (last 30 days)
            User.aggregate([
                { $match: { lastLoginAt: { $gte: thirtyDaysAgo } } },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$lastLoginAt' }
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]),

            // Daily messages (DMs) — last 30 days
            Message.aggregate([
                {
                    $match: {
                        createdAt: { $gte: thirtyDaysAgo },
                        deletedForEveryone: { $ne: true }
                    }
                },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]),

            // Daily content uploads (last 30 days)
            Content.aggregate([
                { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                {
                    $group: {
                        _id: {
                            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                            type: '$contentType'
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { '_id.date': 1 } }
            ]),

            // Content by status
            Content.aggregate([
                {
                    $group: {
                        _id: '$status',
                        count: { $sum: 1 }
                    }
                }
            ]),
        ]);

        // ─── Format daily data with zero-fill ─────────────────────────────

        const days = getLastNDays(30);
        const dayLabels = days.map(d => d.toISOString().slice(0, 10));

        // Build lookup maps
        const signupMap = Object.fromEntries(dailySignups.map(r => [r._id, r.count]));
        const watchTimeMap = Object.fromEntries(dailyWatchTime.map(r => [r._id, r.totalWatchTime]));
        const loginMap = Object.fromEntries(dailyLogins.map(r => [r._id, r.count]));
        const messageMap = Object.fromEntries(dailyMessages.map(r => [r._id, r.count]));

        // Aggregate daily uploads into a map: date → { video, short, audio, post }
        const uploadMap = {};
        for (const r of dailyUploads) {
            if (!uploadMap[r._id.date]) uploadMap[r._id.date] = { video: 0, short: 0, audio: 0, post: 0 };
            uploadMap[r._id.date][r._id.type] = r.count;
        }

        const dailyData = dayLabels.map(date => ({
            date,
            signups: signupMap[date] || 0,
            watchTime: Math.round((watchTimeMap[date] || 0) / 60), // convert seconds → minutes
            logins: loginMap[date] || 0,
            messages: messageMap[date] || 0,
            uploads: uploadMap[date] || { video: 0, short: 0, audio: 0, post: 0 },
        }));

        // ─── Format monthly signups with zero-fill ────────────────────────

        const months = getLastNMonths(12);
        const monthLabels = months.map(d => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            return `${y}-${m}`;
        });

        const monthlySignupMap = Object.fromEntries(monthlySignups.map(r => [r._id, r.count]));

        const monthlyData = monthLabels.map(month => ({
            month,
            signups: monthlySignupMap[month] || 0,
        }));

        // ─── Content type distribution ────────────────────────────────────

        const contentTypeMap = Object.fromEntries(totalContentByType.map(r => [r._id, r.count]));
        const contentStatusMap = Object.fromEntries(contentByStatus.map(r => [r._id, r.count]));

        // ─── Total watch time in hours ────────────────────────────────────
        const totalWatchTimeSec = totalWatchTimeResult[0]?.total || 0;

        return res.status(200).json({
            success: true,
            analytics: {
                summary: {
                    totalUsers,
                    totalChannels,
                    totalUsersWithoutChannel,
                    totalWatchTimeHours: Math.round(totalWatchTimeSec / 3600 * 10) / 10,
                    totalWatchTimeMinutes: Math.round(totalWatchTimeSec / 60),
                    totalMessages: (totalMessagesResult || 0) + (totalCommunityMessagesResult || 0),
                    totalDMs: totalMessagesResult || 0,
                    totalCommunityMessages: totalCommunityMessagesResult || 0,
                    contentByType: {
                        video: contentTypeMap['video'] || 0,
                        short: contentTypeMap['short'] || 0,
                        audio: contentTypeMap['audio'] || 0,
                        post: contentTypeMap['post'] || 0,
                    },
                    contentByStatus: {
                        uploading: contentStatusMap['uploading'] || 0,
                        processing: contentStatusMap['processing'] || 0,
                        completed: contentStatusMap['completed'] || 0,
                        failed: contentStatusMap['failed'] || 0,
                        removed: contentStatusMap['removed'] || 0,
                    },
                },
                dailyData,
                monthlyData,
            }
        });
    } catch (error) {
        console.error('Analytics error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
