import PageUsage from '../../models/pageUsage.model.js';
import ContentWatchtime from '../../models/contentWatchtime.model.js';
import UserSession from '../../models/userSession.model.js';
import AnalyticsSummary from '../../models/analyticsSummary.model.js';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import WatchHistory from '../../models/watchHistory.model.js';
import mongoose from 'mongoose';

/**
 * Helper: generate date range based on period filter
 */
function getDateRange(period = '30d') {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let start;

    switch (period) {
        case '7d':
            start = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
        case '30d':
            start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
        case '90d':
            start = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
            break;
        case '12m':
            start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
            break;
        case 'all':
            start = new Date(2020, 0, 1);
            break;
        default:
            start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    return { start, end: now };
}

/**
 * Helper: generate day labels for a date range
 */
function getDayLabels(start, end) {
    const labels = [];
    const current = new Date(start);
    while (current <= end) {
        labels.push(current.toISOString().slice(0, 10));
        current.setDate(current.getDate() + 1);
    }
    return labels;
}

// ─── PLATFORM ANALYTICS ──────────────────────────────────────────────────────

/**
 * GET /admin/analytics/platform
 * Platform-wide usage analytics with time filters.
 */
export const getPlatformAnalytics = async (req, res) => {
    try {
        const period = req.query.period || '30d';
        const { start, end } = getDateRange(period);
        const startDateStr = start.toISOString().slice(0, 10);

        const [
            // Session stats
            totalSessions,
            authenticatedSessions,
            avgSessionDuration,
            dailySessions,

            // Page usage stats
            pageUsageBreakdown,
            dailyPageUsage,

            // Content watchtime
            watchtimeByType,
            dailyWatchtime,

            // Device breakdown
            deviceBreakdown,
        ] = await Promise.all([
            // Total sessions in period
            UserSession.countDocuments({ startedAt: { $gte: start } }),

            // Authenticated sessions
            UserSession.countDocuments({ startedAt: { $gte: start }, isAuthenticated: true }),

            // Average session duration
            UserSession.aggregate([
                { $match: { startedAt: { $gte: start }, totalDuration: { $gt: 0 } } },
                { $group: { _id: null, avg: { $avg: '$totalDuration' } } },
            ]),

            // Daily sessions
            UserSession.aggregate([
                { $match: { startedAt: { $gte: start } } },
                {
                    $group: {
                        _id: '$dateBucket',
                        count: { $sum: 1 },
                        avgDuration: { $avg: '$totalDuration' },
                        authenticated: { $sum: { $cond: ['$isAuthenticated', 1, 0] } },
                    },
                },
                { $sort: { _id: 1 } },
            ]),

            // Page usage breakdown (total time per page)
            PageUsage.aggregate([
                { $match: { createdAt: { $gte: start } } },
                {
                    $group: {
                        _id: '$pageName',
                        totalTime: { $sum: '$timeSpent' },
                        visits: { $sum: 1 },
                    },
                },
                { $sort: { totalTime: -1 } },
            ]),

            // Daily page usage
            PageUsage.aggregate([
                { $match: { createdAt: { $gte: start } } },
                {
                    $group: {
                        _id: { date: '$dateBucket', page: '$pageName' },
                        totalTime: { $sum: '$timeSpent' },
                        visits: { $sum: 1 },
                    },
                },
                { $sort: { '_id.date': 1 } },
            ]),

            // Watchtime by content type
            ContentWatchtime.aggregate([
                { $match: { createdAt: { $gte: start } } },
                {
                    $group: {
                        _id: '$contentType',
                        totalPlayTime: { $sum: '$activePlayTime' },
                        totalBufferTime: { $sum: '$totalBufferTime' },
                        totalPauseTime: { $sum: '$totalPauseTime' },
                        count: { $sum: 1 },
                        avgCompletion: { $avg: '$consumptionPercent' },
                    },
                },
            ]),

            // Daily content watchtime
            ContentWatchtime.aggregate([
                { $match: { createdAt: { $gte: start } } },
                {
                    $group: {
                        _id: { date: '$dateBucket', type: '$contentType' },
                        totalPlayTime: { $sum: '$activePlayTime' },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { '_id.date': 1 } },
            ]),

            // Device breakdown for sessions
            UserSession.aggregate([
                { $match: { startedAt: { $gte: start } } },
                {
                    $group: {
                        _id: '$device',
                        count: { $sum: 1 },
                        avgDuration: { $avg: '$totalDuration' },
                    },
                },
            ]),
        ]);

        // Format page usage into map
        const pageMap = {};
        for (const p of pageUsageBreakdown) {
            pageMap[p._id] = { totalTime: Math.round(p.totalTime / 60), visits: p.visits };
        }

        // Format watchtime by type
        const watchtimeMap = {};
        for (const w of watchtimeByType) {
            watchtimeMap[w._id] = {
                totalPlayMinutes: Math.round(w.totalPlayTime / 60),
                totalBufferMinutes: Math.round(w.totalBufferTime / 60),
                count: w.count,
                avgCompletion: Math.round(w.avgCompletion || 0),
            };
        }

        // Format daily data with zero-fill
        const dayLabels = getDayLabels(start, end);
        const sessionMap = Object.fromEntries(dailySessions.map(r => [r._id, r]));

        // Build daily watchtime map
        const dailyWtMap = {};
        for (const r of dailyWatchtime) {
            if (!dailyWtMap[r._id.date]) dailyWtMap[r._id.date] = {};
            dailyWtMap[r._id.date][r._id.type] = Math.round(r.totalPlayTime / 60);
        }

        const dailyData = dayLabels.map(date => ({
            date,
            sessions: sessionMap[date]?.count || 0,
            avgDuration: Math.round((sessionMap[date]?.avgDuration || 0) / 60),
            authenticated: sessionMap[date]?.authenticated || 0,
            watchtime: dailyWtMap[date] || { video: 0, short: 0, audio: 0, post: 0 },
        }));

        // Device format
        const deviceMap = {};
        for (const d of deviceBreakdown) {
            deviceMap[d._id || 'desktop'] = { count: d.count, avgDuration: Math.round(d.avgDuration / 60) };
        }

        return res.status(200).json({
            success: true,
            platform: {
                summary: {
                    totalSessions,
                    authenticatedSessions,
                    anonymousSessions: totalSessions - authenticatedSessions,
                    avgSessionMinutes: Math.round((avgSessionDuration[0]?.avg || 0) / 60),
                },
                pageUsage: pageMap,
                contentWatchtime: watchtimeMap,
                deviceBreakdown: deviceMap,
                dailyData,
            },
        });
    } catch (error) {
        console.error('getPlatformAnalytics error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── CONTENT ANALYTICS ───────────────────────────────────────────────────────

/**
 * GET /admin/analytics/content
 * Most watched content, content performance analytics.
 */
export const getContentAnalytics = async (req, res) => {
    try {
        const period = req.query.period || '30d';
        const contentType = req.query.type || null; // video, short, audio, post, or null for all
        const { start } = getDateRange(period);

        const matchStage = { createdAt: { $gte: start } };
        if (contentType) matchStage.contentType = contentType;

        const [
            // Most watched content
            topContent,

            // Content performance over time
            dailyContent,

            // Content type distribution
            typeDistribution,

            // Average completion rates
            completionRates,
        ] = await Promise.all([
            // Top 20 most watched content
            ContentWatchtime.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: { contentId: '$contentId', contentType: '$contentType' },
                        totalPlayTime: { $sum: '$activePlayTime' },
                        viewCount: { $sum: 1 },
                        avgCompletion: { $avg: '$consumptionPercent' },
                    },
                },
                { $sort: { totalPlayTime: -1 } },
                { $limit: 20 },
                {
                    $lookup: {
                        from: 'contents',
                        localField: '_id.contentId',
                        foreignField: '_id',
                        as: 'content',
                    },
                },
                { $unwind: { path: '$content', preserveNullAndEmptyArrays: true } },
                {
                    $project: {
                        contentId: '$_id.contentId',
                        contentType: '$_id.contentType',
                        title: '$content.title',
                        thumbnailKey: '$content.thumbnailKey',
                        totalPlayMinutes: { $round: [{ $divide: ['$totalPlayTime', 60] }, 1] },
                        viewCount: 1,
                        avgCompletion: { $round: ['$avgCompletion', 0] },
                    },
                },
            ]),

            // Daily content consumption
            ContentWatchtime.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: { date: '$dateBucket', type: '$contentType' },
                        totalPlayTime: { $sum: '$activePlayTime' },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { '_id.date': 1 } },
            ]),

            // Content type distribution (watchtime share)
            ContentWatchtime.aggregate([
                { $match: { createdAt: { $gte: start } } },
                {
                    $group: {
                        _id: '$contentType',
                        totalPlayTime: { $sum: '$activePlayTime' },
                        count: { $sum: 1 },
                    },
                },
            ]),

            // Completion rates by type
            ContentWatchtime.aggregate([
                { $match: { createdAt: { $gte: start } } },
                {
                    $group: {
                        _id: '$contentType',
                        avgCompletion: { $avg: '$consumptionPercent' },
                        completedCount: { $sum: { $cond: ['$completed', 1, 0] } },
                        totalCount: { $sum: 1 },
                    },
                },
            ]),
        ]);

        // Format type distribution for pie chart
        const typePie = typeDistribution.map(t => ({
            name: t._id,
            value: Math.round(t.totalPlayTime / 60),
            count: t.count,
        }));

        // Format completion rates
        const completionMap = {};
        for (const c of completionRates) {
            completionMap[c._id] = {
                avgCompletion: Math.round(c.avgCompletion || 0),
                completionRate: c.totalCount > 0 ? Math.round((c.completedCount / c.totalCount) * 100) : 0,
            };
        }

        return res.status(200).json({
            success: true,
            content: {
                topContent,
                dailyContent,
                typeDistribution: typePie,
                completionRates: completionMap,
            },
        });
    } catch (error) {
        console.error('getContentAnalytics error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── USER ANALYTICS ──────────────────────────────────────────────────────────

/**
 * GET /admin/analytics/user/:userId
 * Detailed analytics for a specific user.
 */
export const getUserAnalytics = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid userId' });
        }

        const [
            // User info
            user,

            // Total watchtime
            totalWatchtime,

            // Page usage breakdown
            pageUsage,

            // Content type breakdown
            contentBreakdown,

            // Session history (last 30)
            recentSessions,

            // Watch history stats
            watchHistoryStats,
        ] = await Promise.all([
            // Basic user info
            User.findById(userId).select('email channelName channelHandle profilePicture lastLoginAt').lean(),

            // Total platform watchtime (from ContentWatchtime)
            ContentWatchtime.aggregate([
                { $match: { userId: new mongoose.Types.ObjectId(userId) } },
                { $group: { _id: null, total: { $sum: '$activePlayTime' } } },
            ]),

            // Page usage breakdown
            PageUsage.aggregate([
                { $match: { userId: new mongoose.Types.ObjectId(userId) } },
                {
                    $group: {
                        _id: '$pageName',
                        totalTime: { $sum: '$timeSpent' },
                        visits: { $sum: 1 },
                    },
                },
                { $sort: { totalTime: -1 } },
            ]),

            // Content watchtime by type
            ContentWatchtime.aggregate([
                { $match: { userId: new mongoose.Types.ObjectId(userId) } },
                {
                    $group: {
                        _id: '$contentType',
                        totalPlayTime: { $sum: '$activePlayTime' },
                        count: { $sum: 1 },
                        avgCompletion: { $avg: '$consumptionPercent' },
                    },
                },
            ]),

            // Recent sessions
            UserSession.find({ userId: new mongoose.Types.ObjectId(userId) })
                .sort({ startedAt: -1 })
                .limit(30)
                .select('startedAt endedAt totalDuration device pagesVisited')
                .lean(),

            // Legacy watch history stats
            WatchHistory.aggregate([
                { $match: { userId: new mongoose.Types.ObjectId(userId) } },
                {
                    $group: {
                        _id: '$contentType',
                        totalWatchTime: { $sum: '$watchTime' },
                        count: { $sum: 1 },
                    },
                },
            ]),
        ]);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Format page usage
        const pageMap = {};
        for (const p of pageUsage) {
            pageMap[p._id] = { totalMinutes: Math.round(p.totalTime / 60), visits: p.visits };
        }

        // Format content breakdown
        const contentMap = {};
        for (const c of contentBreakdown) {
            contentMap[c._id] = {
                totalMinutes: Math.round(c.totalPlayTime / 60),
                count: c.count,
                avgCompletion: Math.round(c.avgCompletion || 0),
            };
        }

        return res.status(200).json({
            success: true,
            user: {
                ...user,
                totalWatchtimeMinutes: Math.round((totalWatchtime[0]?.total || 0) / 60),
                pageUsage: pageMap,
                contentBreakdown: contentMap,
                recentSessions: recentSessions.map(s => ({
                    startedAt: s.startedAt,
                    endedAt: s.endedAt,
                    durationMinutes: Math.round((s.totalDuration || 0) / 60),
                    device: s.device,
                    pagesCount: s.pagesVisited?.length || 0,
                })),
                legacyWatchHistory: watchHistoryStats,
            },
        });
    } catch (error) {
        console.error('getUserAnalytics error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * GET /admin/analytics/user-search?q=...
 * Search users for analytics drill-down.
 */
export const searchUsersForAnalytics = async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q || q.length < 2) {
            return res.status(400).json({ success: false, message: 'Query must be at least 2 characters' });
        }

        const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

        const users = await User.find({
            $or: [
                { email: regex },
                { channelName: regex },
                { channelHandle: regex },
            ],
        })
            .select('email channelName channelHandle profilePicture')
            .limit(20)
            .lean();

        return res.status(200).json({ success: true, users });
    } catch (error) {
        console.error('searchUsersForAnalytics error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── AGGREGATION JOB ─────────────────────────────────────────────────────────

/**
 * POST /admin/analytics/aggregate
 * Trigger aggregation to build AnalyticsSummary for a given date.
 * Typically called by a cron job or manually by superadmin.
 */
export const runAggregation = async (req, res) => {
    try {
        const dateStr = req.body.date || new Date().toISOString().slice(0, 10);
        const dayStart = new Date(dateStr + 'T00:00:00.000Z');
        const dayEnd = new Date(dateStr + 'T23:59:59.999Z');

        const [sessions, pageUsage, contentWt] = await Promise.all([
            UserSession.aggregate([
                { $match: { dateBucket: dateStr } },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        authenticated: { $sum: { $cond: ['$isAuthenticated', 1, 0] } },
                        avgDuration: { $avg: '$totalDuration' },
                        totalDuration: { $sum: '$totalDuration' },
                        desktopCount: { $sum: { $cond: [{ $eq: ['$device', 'desktop'] }, 1, 0] } },
                        mobileCount: { $sum: { $cond: [{ $eq: ['$device', 'mobile'] }, 1, 0] } },
                        tabletCount: { $sum: { $cond: [{ $eq: ['$device', 'tablet'] }, 1, 0] } },
                    },
                },
            ]),
            PageUsage.aggregate([
                { $match: { dateBucket: dateStr } },
                {
                    $group: {
                        _id: '$pageName',
                        totalTime: { $sum: '$timeSpent' },
                    },
                },
            ]),
            ContentWatchtime.aggregate([
                { $match: { dateBucket: dateStr } },
                {
                    $group: {
                        _id: '$contentType',
                        totalPlayTime: { $sum: '$activePlayTime' },
                        count: { $sum: 1 },
                    },
                },
            ]),
        ]);

        const s = sessions[0] || {};

        const pageObj = {};
        for (const p of pageUsage) pageObj[p._id] = Math.round(p.totalTime);

        const wtObj = {};
        const consumedObj = {};
        for (const c of contentWt) {
            wtObj[c._id] = Math.round(c.totalPlayTime);
            consumedObj[c._id] = c.count;
        }

        await AnalyticsSummary.findOneAndUpdate(
            { period: 'daily', dateKey: dateStr },
            {
                $set: {
                    totalSessions: s.total || 0,
                    authenticatedSessions: s.authenticated || 0,
                    anonymousSessions: (s.total || 0) - (s.authenticated || 0),
                    avgSessionDuration: Math.round(s.avgDuration || 0),
                    totalPlatformTime: Math.round(s.totalDuration || 0),
                    pageUsage: pageObj,
                    contentWatchtime: wtObj,
                    contentConsumed: consumedObj,
                    deviceBreakdown: {
                        desktop: s.desktopCount || 0,
                        mobile: s.mobileCount || 0,
                        tablet: s.tabletCount || 0,
                    },
                },
            },
            { upsert: true }
        );

        return res.status(200).json({ success: true, message: `Aggregated for ${dateStr}` });
    } catch (error) {
        console.error('runAggregation error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
