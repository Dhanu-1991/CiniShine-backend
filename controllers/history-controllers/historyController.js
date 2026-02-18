/**
 * Watch History Controller
 * Manages user's viewing history with 100-item cap, pagination, and pause toggle
 *
 * Endpoints:
 * - GET    /api/v2/history               - Get paginated watch history
 * - DELETE /api/v2/history               - Delete selected history items
 * - DELETE /api/v2/history/all           - Clear all history
 * - PUT    /api/v2/history/pause         - Toggle history tracking pause
 * - GET    /api/v2/history/pause-status  - Get current pause status
 *
 * History cap: 100 items per user. When 101st is added, oldest is deleted.
 * This is enforced in sharedContentController.js when WatchHistory is upserted.
 */

import mongoose from 'mongoose';
import WatchHistory from '../../models/watchHistory.model.js';
import Content from '../../models/content.model.js';
import User from '../../models/user.model.js';
import { getCfUrl } from '../../../config/cloudfront.js';

/**
 * Get paginated watch history for the current user
 * Sorted by lastWatchedAt (most recent first)
 */
export const getWatchHistory = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { page = 1, limit = 20, type } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const query = { userId };
        if (type && ['video', 'short', 'audio', 'post'].includes(type)) {
            query.contentType = type;
        }

        const [historyItems, total] = await Promise.all([
            WatchHistory.find(query)
                .sort({ lastWatchedAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            WatchHistory.countDocuments(query)
        ]);

        // Populate content data with signed URLs
        const enrichedHistory = await Promise.all(historyItems.map(async (item) => {
            const content = await Content.findById(item.contentId).lean();
            if (!content) {
                // Content was deleted, use cached metadata
                return {
                    _id: item._id,
                    contentId: item.contentId,
                    contentType: item.contentType,
                    title: item.contentMetadata?.title || 'Deleted content',
                    thumbnailUrl: null,
                    imageUrl: null,
                    duration: item.contentMetadata?.duration || 0,
                    views: 0,
                    status: 'completed',
                    watchTime: item.watchTime,
                    watchPercentage: item.watchPercentage,
                    watchCount: item.watchCount || 1,
                    lastWatchedAt: item.lastWatchedAt,
                    createdAt: item.lastWatchedAt,
                    deleted: true,
                };
            }

            // Get channel picture from user
            const creator = await User.findById(content.userId, 'channelPicture channelName profilePicture').lean();
            let channelPicUrl = null;
            if (creator?.channelPicture) {
                channelPicUrl = getCfUrl(creator.channelPicture);
            }

            return {
                _id: item._id,
                contentId: content._id,
                contentType: content.contentType,
                title: content.title,
                description: content.description,
                thumbnailUrl: getCfUrl(content.thumbnailKey),
                imageUrl: getCfUrl(content.imageKey),
                duration: content.duration,
                views: content.views || 0,
                likeCount: content.likeCount || 0,
                status: 'completed',
                watchTime: item.watchTime,
                watchPercentage: item.watchPercentage,
                watchCount: item.watchCount || 1,
                lastWatchedAt: item.lastWatchedAt,
                createdAt: content.createdAt || item.lastWatchedAt,
                channelName: content.channelName || creator?.channelName,
                channelPicture: channelPicUrl,
                userId: content.userId,
                deleted: false,
            };
        }));

        res.json({
            history: enrichedHistory,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                hasNextPage: skip + parseInt(limit) < total,
            }
        });
    } catch (error) {
        console.error('❌ Error fetching watch history:', error);
        res.status(500).json({ error: 'Failed to fetch watch history' });
    }
};

/**
 * Delete selected history items
 * Body: { ids: [watchHistoryId1, watchHistoryId2, ...] }
 */
export const deleteHistoryItems = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const ids = req.body.ids || req.body.historyIds;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Provide an array of history item IDs' });
        }

        const result = await WatchHistory.deleteMany({
            _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
            userId, // Only delete items belonging to this user
        });

        res.json({
            success: true,
            deletedCount: result.deletedCount,
            message: `${result.deletedCount} history item(s) deleted`
        });
    } catch (error) {
        console.error('❌ Error deleting history items:', error);
        res.status(500).json({ error: 'Failed to delete history items' });
    }
};

/**
 * Clear all watch history for the current user
 */
export const deleteAllHistory = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const result = await WatchHistory.deleteMany({ userId });

        res.json({
            success: true,
            deletedCount: result.deletedCount,
            message: 'All watch history cleared'
        });
    } catch (error) {
        console.error('❌ Error clearing history:', error);
        res.status(500).json({ error: 'Failed to clear history' });
    }
};

/**
 * Toggle history tracking pause
 * No body required - reads current state and flips it
 */
export const toggleHistoryPause = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const user = await User.findById(userId, 'historyPaused');
        const newPausedState = !(user?.historyPaused || false);

        await User.findByIdAndUpdate(userId, { historyPaused: newPausedState });

        res.json({
            success: true,
            historyPaused: newPausedState,
            message: newPausedState ? 'History tracking paused' : 'History tracking resumed'
        });
    } catch (error) {
        console.error('❌ Error toggling history pause:', error);
        res.status(500).json({ error: 'Failed to toggle history pause' });
    }
};

/**
 * Get current history pause status
 */
export const getHistoryPauseStatus = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const user = await User.findById(userId, 'historyPaused');
        res.json({ historyPaused: user?.historyPaused || false });
    } catch (error) {
        console.error('❌ Error getting pause status:', error);
        res.status(500).json({ error: 'Failed to get pause status' });
    }
};
