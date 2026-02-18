/**
 * Bookmark Controller
 * 
 * Endpoints:
 * - POST   /api/v2/bookmarks          — Toggle bookmark (add/remove)
 * - GET    /api/v2/bookmarks           — Get all bookmarks (paginated, grouped by type)
 * - GET    /api/v2/bookmarks/:type     — Get bookmarks by content type (paginated)
 * - GET    /api/v2/bookmarks/status/:contentId — Check if content is bookmarked
 * - DELETE /api/v2/bookmarks/:contentId — Remove a specific bookmark
 */

import Bookmark from '../../models/bookmark.model.js';
import Content from '../../models/content.model.js';
import { getCfUrl } from '../../config/cloudfront.js';

/**
 * Toggle bookmark — if already bookmarked, remove it; otherwise add it.
 * POST /api/v2/bookmarks
 * Body: { contentId, contentType }
 */
export const toggleBookmark = async (req, res) => {
    try {
        const userId = req.user.id;
        const { contentId, contentType } = req.body;

        if (!contentId || !contentType) {
            return res.status(400).json({ message: 'contentId and contentType are required' });
        }

        if (!['video', 'short', 'audio', 'post'].includes(contentType)) {
            return res.status(400).json({ message: 'Invalid contentType. Must be video, short, audio, or post' });
        }

        // Check if content exists
        const content = await Content.findById(contentId);
        if (!content) {
            return res.status(404).json({ message: 'Content not found' });
        }

        // Toggle
        const existing = await Bookmark.findOne({ userId, contentId });
        if (existing) {
            await Bookmark.deleteOne({ _id: existing._id });
            return res.json({ bookmarked: false, message: 'Bookmark removed' });
        }

        await Bookmark.create({ userId, contentId, contentType });
        return res.status(201).json({ bookmarked: true, message: 'Bookmark added' });
    } catch (error) {
        console.error('Error toggling bookmark:', error);
        if (error.code === 11000) {
            // Duplicate key — race condition, already bookmarked
            return res.json({ bookmarked: true, message: 'Already bookmarked' });
        }
        return res.status(500).json({ message: 'Failed to toggle bookmark' });
    }
};

/**
 * Get bookmark status for a specific content
 * GET /api/v2/bookmarks/status/:contentId
 */
export const getBookmarkStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const { contentId } = req.params;

        const existing = await Bookmark.findOne({ userId, contentId });
        return res.json({ bookmarked: !!existing });
    } catch (error) {
        console.error('Error checking bookmark status:', error);
        return res.status(500).json({ message: 'Failed to check bookmark status' });
    }
};

/**
 * Get bookmarks by content type (paginated)
 * GET /api/v2/bookmarks/:type?page=1&limit=12
 */
export const getBookmarksByType = async (req, res) => {
    try {
        const userId = req.user.id;
        const { type } = req.params;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 12));
        const skip = (page - 1) * limit;

        if (!['video', 'short', 'audio', 'post'].includes(type)) {
            return res.status(400).json({ message: 'Invalid type. Must be video, short, audio, or post' });
        }

        const [bookmarks, total] = await Promise.all([
            Bookmark.find({ userId, contentType: type })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Bookmark.countDocuments({ userId, contentType: type })
        ]);

        // Populate content details
        const contentIds = bookmarks.map(b => b.contentId);
        const contents = await Content.find({ _id: { $in: contentIds } })
            .populate('userId', 'channelName channelHandle channelPicture profilePicture')
            .lean();

        const contentMap = {};
        contents.forEach(c => {
            // Add CloudFront URLs
            if (c.thumbnailKey) c.thumbnailUrl = getCfUrl(c.thumbnailKey);
            if (c.imageKey) c.imageUrl = getCfUrl(c.imageKey);
            if (c.imageKeys?.length) c.imageUrls = c.imageKeys.map(k => getCfUrl(k));
            if (c.userId?.channelPicture) c.channelPicture = getCfUrl(c.userId.channelPicture);
            c.channelName = c.userId?.channelName;
            c.channelHandle = c.userId?.channelHandle;
            contentMap[c._id.toString()] = c;
        });

        const items = bookmarks
            .map(b => {
                const content = contentMap[b.contentId.toString()];
                if (!content) return null;
                return {
                    bookmarkId: b._id,
                    bookmarkedAt: b.createdAt,
                    ...content
                };
            })
            .filter(Boolean);

        return res.json({
            items,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore: skip + items.length < total
        });
    } catch (error) {
        console.error('Error fetching bookmarks by type:', error);
        return res.status(500).json({ message: 'Failed to fetch bookmarks' });
    }
};

/**
 * Get all bookmarks with counts per type
 * GET /api/v2/bookmarks?page=1&limit=12
 */
export const getAllBookmarks = async (req, res) => {
    try {
        const userId = req.user.id;

        // Get counts per type
        const counts = await Bookmark.aggregate([
            { $match: { userId: new (await import('mongoose')).default.Types.ObjectId(userId) } },
            { $group: { _id: '$contentType', count: { $sum: 1 } } }
        ]);

        const countMap = { video: 0, short: 0, audio: 0, post: 0 };
        counts.forEach(c => { countMap[c._id] = c.count; });

        return res.json({
            counts: countMap,
            total: Object.values(countMap).reduce((a, b) => a + b, 0)
        });
    } catch (error) {
        console.error('Error fetching all bookmarks:', error);
        return res.status(500).json({ message: 'Failed to fetch bookmarks' });
    }
};

/**
 * Remove a specific bookmark
 * DELETE /api/v2/bookmarks/:contentId
 */
export const removeBookmark = async (req, res) => {
    try {
        const userId = req.user.id;
        const { contentId } = req.params;

        const result = await Bookmark.deleteOne({ userId, contentId });
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Bookmark not found' });
        }

        return res.json({ message: 'Bookmark removed', bookmarked: false });
    } catch (error) {
        console.error('Error removing bookmark:', error);
        return res.status(500).json({ message: 'Failed to remove bookmark' });
    }
};
