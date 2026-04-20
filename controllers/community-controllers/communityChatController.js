import mongoose from 'mongoose';
import CommunityChat from '../../models/communityChat.model.js';
import CommunityMember from '../../models/communityMember.model.js';
import Community from '../../models/community.model.js';
import ContentReport from '../../models/contentReport.model.js';
import ContentToCommunity from '../../models/contentToCommunity.model.js';
import Content from '../../models/content.model.js';
import WatchHistory from '../../models/watchHistory.model.js';
import User from '../../models/user.model.js';
import ContentView from '../../models/contentView.model.js';

const ROLE_HIERARCHY = { OWNER: 4, ADMIN: 3, MODERATOR: 2, MEMBER: 1, PENDING: 0, BANNED: -1 };

// ═══════════════════════════════════════════════════
// Helper: get user membership
// ═══════════════════════════════════════════════════
async function getMembership(communityId, userId) {
    return CommunityMember.findOne({ communityId, userId, status: 'ACTIVE' }).lean();
}

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/chat — Send community chat message
// ═══════════════════════════════════════════════════
export const sendChatMessage = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { id } = req.params;
        const { text, contentRef, replyTo } = req.body;

        if (!text?.trim()) return res.status(400).json({ error: 'Message text is required' });
        if (text.length > 2000) return res.status(400).json({ error: 'Message too long (max 2000 chars)' });

        const membership = await getMembership(id, userId);
        if (!membership) return res.status(403).json({ error: 'Must be an active community member' });
        if (membership.role === 'BANNED') return res.status(403).json({ error: 'You are banned from this community' });

        const msg = await CommunityChat.create({
            communityId: id,
            senderId: userId,
            text: text.trim(),
            contentRef: contentRef || {},
            replyTo: replyTo || null,
        });

        const populated = await CommunityChat.findById(msg._id)
            .populate('senderId', 'userName channelName channelPicture channelHandle')
            .populate('replyTo', 'text senderId')
            .lean();

        // Attach sender role
        populated.senderRole = membership.role;

        return res.status(201).json({ message: populated });
    } catch (error) {
        console.error('sendChatMessage error:', error);
        return res.status(500).json({ error: 'Failed to send message' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/:id/chat — Get community chat messages
// ═══════════════════════════════════════════════════
export const getChatMessages = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { id } = req.params;
        const { cursor, limit = 50, search } = req.query;
        const pageLimit = Math.min(parseInt(limit) || 50, 100);

        const membership = await getMembership(id, userId);
        if (!membership) return res.status(403).json({ error: 'Must be an active community member' });

        const query = { communityId: id };
        if (cursor) query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
        if (search?.trim()) {
            query.text = { $regex: search.trim(), $options: 'i' };
        }

        const messages = await CommunityChat.find(query)
            .sort({ createdAt: -1 })
            .limit(pageLimit + 1)
            .populate('senderId', 'userName channelName channelPicture channelHandle')
            .populate('replyTo', 'text senderId')
            .lean();

        const hasMore = messages.length > pageLimit;
        if (hasMore) messages.pop();

        // Attach sender roles
        const senderIds = [...new Set(messages.map(m => m.senderId?._id?.toString()).filter(Boolean))];
        const memberships = await CommunityMember.find({
            communityId: id,
            userId: { $in: senderIds.map(s => new mongoose.Types.ObjectId(s)) },
            status: 'ACTIVE'
        }).lean();
        const roleMap = {};
        memberships.forEach(m => { roleMap[m.userId.toString()] = m.role; });

        messages.forEach(m => {
            if (m.senderId?._id) {
                m.senderRole = roleMap[m.senderId._id.toString()] || 'MEMBER';
            }
            // Replace content of deleted messages
            if (m.deletedForEveryone) {
                m.text = '🗑️ This message was deleted';
                m.contentRef = null;
            }
        });

        // Reverse to chronological order
        messages.reverse();

        return res.json({
            messages,
            nextCursor: hasMore && messages.length > 0 ? messages[0]._id : null,
            hasMore
        });
    } catch (error) {
        console.error('getChatMessages error:', error);
        return res.status(500).json({ error: 'Failed to get messages' });
    }
};

// ═══════════════════════════════════════════════════
// PATCH /api/v2/communities/:id/chat/:messageId — Edit message
// ═══════════════════════════════════════════════════
export const editChatMessage = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { id, messageId } = req.params;
        const { text } = req.body;

        if (!text?.trim()) return res.status(400).json({ error: 'New text required' });

        const msg = await CommunityChat.findOne({ _id: messageId, communityId: id });
        if (!msg) return res.status(404).json({ error: 'Message not found' });
        if (msg.senderId.toString() !== userId) return res.status(403).json({ error: 'Can only edit your own messages' });
        if (msg.deletedForEveryone) return res.status(400).json({ error: 'Cannot edit deleted message' });

        msg.text = text.trim();
        msg.editedAt = new Date();
        await msg.save();

        return res.json({ message: msg });
    } catch (error) {
        console.error('editChatMessage error:', error);
        return res.status(500).json({ error: 'Failed to edit message' });
    }
};

// ═══════════════════════════════════════════════════
// DELETE /api/v2/communities/:id/chat/:messageId — Delete message for everyone
// ═══════════════════════════════════════════════════
export const deleteChatMessage = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { id, messageId } = req.params;

        const msg = await CommunityChat.findOne({ _id: messageId, communityId: id });
        if (!msg) return res.status(404).json({ error: 'Message not found' });

        const isSender = msg.senderId.toString() === userId;

        // Mods+ can delete any message
        if (!isSender) {
            const membership = await getMembership(id, userId);
            if (!membership || ROLE_HIERARCHY[membership.role] < ROLE_HIERARCHY.MODERATOR) {
                return res.status(403).json({ error: 'Only the sender or moderators+ can delete messages' });
            }
        }

        msg.deletedForEveryone = true;
        msg.deletedForEveryoneAt = new Date();
        msg.deletedBy = userId;
        await msg.save();

        return res.json({ message: 'Message deleted', messageId });
    } catch (error) {
        console.error('deleteChatMessage error:', error);
        return res.status(500).json({ error: 'Failed to delete message' });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/report — Report content
// ═══════════════════════════════════════════════════
export const reportContent = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { contentId, communityId, reason, description } = req.body;
        if (!contentId || !reason) return res.status(400).json({ error: 'contentId and reason are required' });

        const validReasons = ['spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'copyright', 'off_topic', 'other'];
        if (!validReasons.includes(reason)) {
            return res.status(400).json({ error: 'Invalid reason' });
        }

        // Check if user already reported this content
        const existing = await ContentReport.findOne({ contentId, reporterId: userId });
        if (existing) return res.status(409).json({ error: 'You have already reported this content' });

        await ContentReport.create({
            reporterId: userId,
            contentId,
            communityId: communityId || null,
            reason,
            description: description?.trim() || ''
        });

        return res.status(201).json({ message: 'Report submitted successfully' });
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ error: 'You have already reported this content' });
        console.error('reportContent error:', error);
        return res.status(500).json({ error: 'Failed to submit report' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/:contentId/communities — Get communities sharing same content from same creator
// ═══════════════════════════════════════════════════
export const getContentCommunities = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { contentId } = req.params;

        // Find all community links for this content
        const links = await ContentToCommunity.find({ contentId }).lean();
        if (links.length === 0) return res.json({ communities: [] });

        const communityIds = links.map(l => l.communityId);

        // Get only communities the user is a member of
        const memberships = await CommunityMember.find({
            userId,
            communityId: { $in: communityIds },
            status: 'ACTIVE'
        }).lean();

        const memberCommunityIds = memberships.map(m => m.communityId);
        if (memberCommunityIds.length === 0) return res.json({ communities: [] });

        const communities = await Community.find({
            _id: { $in: memberCommunityIds }
        }).select('name communityId avatarUrl memberCount type').lean();

        // Sort by member count desc
        communities.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));

        return res.json({ communities });
    } catch (error) {
        console.error('getContentCommunities error:', error);
        return res.status(500).json({ error: 'Failed to get content communities' });
    }
};

// ═══════════════════════════════════════════════════
// GET /api/v2/communities/recommended — Recommended communities based on watch history
// ═══════════════════════════════════════════════════
export const getRecommendedCommunities = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.json({ communities: [] });

        const { limit = 10 } = req.query;
        const pageLimit = Math.min(parseInt(limit) || 10, 30);

        // 1. Get user's watch history — top creators and categories
        const watchHistory = await WatchHistory.find({ userId })
            .sort({ lastWatchedAt: -1 })
            .limit(200)
            .select('contentMetadata')
            .lean();

        const creatorIds = new Set();
        const categories = new Set();
        const tags = new Set();

        watchHistory.forEach(w => {
            if (w.contentMetadata?.creatorId) creatorIds.add(w.contentMetadata.creatorId.toString());
            if (w.contentMetadata?.category) categories.add(w.contentMetadata.category);
            if (w.contentMetadata?.tags) w.contentMetadata.tags.forEach(t => tags.add(t));
        });

        // 2. Get user's current community memberships to exclude
        const existingMemberships = await CommunityMember.find({
            userId, status: { $in: ['ACTIVE', 'PENDING'] }
        }).select('communityId').lean();
        const excludeIds = existingMemberships.map(m => m.communityId);

        // 3. Find communities owned by the creators the user watches
        const creatorCommunities = await Community.find({
            ownerId: { $in: [...creatorIds].map(id => new mongoose.Types.ObjectId(id)) },
            _id: { $nin: excludeIds },
            type: 'PUBLIC'
        }).select('name communityId avatarUrl description memberCount type ownerId').limit(pageLimit)
            .populate('ownerId', 'channelName channelPicture channelHandle')
            .lean();

        // 4. Find popular public communities the user hasn't joined
        const popularCommunities = await Community.find({
            _id: { $nin: [...excludeIds, ...creatorCommunities.map(c => c._id)] },
            type: 'PUBLIC',
            isSearchVisible: true,
            memberCount: { $gte: 1 }
        }).sort({ memberCount: -1 })
            .limit(pageLimit)
            .select('name communityId avatarUrl description memberCount type ownerId')
            .populate('ownerId', 'channelName channelPicture channelHandle')
            .lean();

        // 5. Merge with priority to creator-based recommendations
        const seen = new Set();
        const result = [];
        for (const c of [...creatorCommunities, ...popularCommunities]) {
            if (seen.has(c._id.toString())) continue;
            seen.add(c._id.toString());
            c.recommendReason = creatorCommunities.includes(c) ? 'creator_you_watch' : 'popular';
            result.push(c);
            if (result.length >= pageLimit) break;
        }

        return res.json({ communities: result });
    } catch (error) {
        console.error('getRecommendedCommunities error:', error);
        return res.json({ communities: [] });
    }
};

// ═══════════════════════════════════════════════════
// POST /api/v2/communities/:id/chat/watch-time — Update watch time for content viewed in community feed
// ═══════════════════════════════════════════════════

// Rate limiter for feed watch time: userId:contentId → last update timestamp
const feedWatchTimeRateLimit = new Map();

const DURATION_BRACKETS = [
    { maxDuration: 5, viewThreshold: 1, cooldownMs: 2000, minWatch: 1, maxWatchFallback: 7.5 },
    { maxDuration: 10, viewThreshold: 2, cooldownMs: 3000, minWatch: 1, maxWatchFallback: 15 },
    { maxDuration: 30, viewThreshold: 5, cooldownMs: 5000, minWatch: 5, maxWatchFallback: 45 },
    { maxDuration: 60, viewThreshold: 5, cooldownMs: 5000, minWatch: 5, maxWatchFallback: 90 },
    { maxDuration: 300, viewThreshold: 10, cooldownMs: 10000, minWatch: 5, maxWatchFallback: 450 },
    { maxDuration: 600, viewThreshold: 15, cooldownMs: 10000, minWatch: 5, maxWatchFallback: 900 },
    { maxDuration: 1800, viewThreshold: 30, cooldownMs: 15000, minWatch: 5, maxWatchFallback: 2700 },
    { maxDuration: 3600, viewThreshold: 30, cooldownMs: 15000, minWatch: 5, maxWatchFallback: 5400 },
    { maxDuration: Infinity, viewThreshold: 30, cooldownMs: 15000, minWatch: 5, maxWatchFallback: null },
];

const UNKNOWN_DURATION_BRACKET = { viewThreshold: 5, cooldownMs: 10000, minWatch: 5, maxWatch: 3600 };

const getBracket = (durationSeconds = 0) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return UNKNOWN_DURATION_BRACKET;
    }

    for (const b of DURATION_BRACKETS) {
        if (durationSeconds <= b.maxDuration) {
            return {
                viewThreshold: b.viewThreshold,
                cooldownMs: b.cooldownMs,
                minWatch: b.minWatch,
                maxWatch: b.maxWatchFallback !== null
                    ? Math.max(b.maxWatchFallback, durationSeconds * 1.5)
                    : durationSeconds * 1.5,
            };
        }
    }

    return UNKNOWN_DURATION_BRACKET;
};

const getMinWatchUpdateGapMs = (durationSeconds = 0) => getBracket(durationSeconds).cooldownMs;

const getViewThresholdSeconds = (contentType, durationSeconds = 0) => {
    if (contentType === 'post') {
        return 1;
    }
    return getBracket(durationSeconds).viewThreshold;
};

const getMinWatchSeconds = (contentType, durationSeconds = 0) => {
    if (contentType === 'post') {
        return 1;
    }
    return getBracket(durationSeconds).minWatch;
};

const getMaxWatchSeconds = (durationSeconds = 0) => getBracket(durationSeconds).maxWatch;

const getViewRecountCooldownMs = (durationSeconds = 0) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return 5 * 60 * 1000;
    }

    return Math.max(durationSeconds * 5 * 1000, 30 * 1000);
};

const buildViewBuckets = (now = new Date()) => {
    const year = now.getFullYear();
    const week = Math.ceil(((now - new Date(year, 0, 1)) / 86400000 + 1) / 7);
    const month = String(now.getMonth() + 1).padStart(2, '0');

    return {
        weekBucket: `${year}-W${String(week).padStart(2, '0')}`,
        monthBucket: `${year}-${month}`,
    };
};

const ensureUniqueContentView = async ({ contentId, userId, now = new Date() }) => {
    const { weekBucket, monthBucket } = buildViewBuckets(now);

    try {
        const result = await ContentView.updateOne(
            { contentId, userId },
            {
                $setOnInsert: {
                    firstViewedAt: now,
                    weekBucket,
                    monthBucket,
                },
            },
            { upsert: true },
        );

        return Boolean(result?.upsertedCount) || Boolean(result?.upsertedId);
    } catch (error) {
        if (error?.code === 11000) {
            return false;
        }
        throw error;
    }
};

export const updateFeedWatchTime = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { contentId, watchTime, duration: clientDuration } = req.body;
        const watchTimeMs = Number(watchTime);
        if (!contentId || !Number.isFinite(watchTimeMs) || watchTimeMs <= 0) {
            return res.status(400).json({ error: 'contentId and positive watchTime required' });
        }

        const content = await Content.findById(contentId);
        if (!content) return res.status(404).json({ error: 'Content not found' });

        // Fix missing duration if client provides one
        const parsedClientDuration = Number(clientDuration);
        if ((!content.duration || content.duration === 0) && Number.isFinite(parsedClientDuration) && parsedClientDuration > 0) {
            content.duration = parsedClientDuration;
        }

        const parsedDuration = Number(content.duration);
        const duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 0;

        const watchTimeSeconds = watchTimeMs / 1000;
        if (!Number.isFinite(watchTimeSeconds) || watchTimeSeconds <= 0) {
            return res.status(400).json({ error: 'Invalid watch time' });
        }

        const minWatchTime = getMinWatchSeconds(content.contentType, duration);
        const maxWatchTime = getMaxWatchSeconds(duration);
        if (watchTimeSeconds < minWatchTime || watchTimeSeconds > maxWatchTime) {
            return res.json({
                message: 'Watch time not counted (outlier)',
                viewCounted: false,
                views: content.views || 0,
                averageWatchTime: content.averageWatchTime || 0,
                totalWatchTime: content.totalWatchTime || 0,
            });
        }

        const now = Date.now();
        const rateKey = `${userId}:${contentId}`;
        const lastUpdate = feedWatchTimeRateLimit.get(rateKey) || 0;
        const minUpdateGapMs = getMinWatchUpdateGapMs(duration);
        if (now - lastUpdate < minUpdateGapMs) {
            return res.json({
                message: 'Watch time not counted (too frequent)',
                rateLimited: true,
                viewCounted: false,
                views: content.views || 0,
                averageWatchTime: content.averageWatchTime || 0,
                totalWatchTime: content.totalWatchTime || 0,
            });
        }
        feedWatchTimeRateLimit.set(rateKey, now);

        // Always accumulate total watch time
        const safeTotalWatchTime = Number(content.totalWatchTime);
        content.totalWatchTime = (Number.isFinite(safeTotalWatchTime) ? safeTotalWatchTime : 0) + watchTimeSeconds;
        await content.save();

        const threshold = getViewThresholdSeconds(content.contentType, duration);
        let viewCounted = false;
        if (watchTimeSeconds >= threshold) {
            const viewer = await User.findById(userId);
            if (viewer) {
                if (!Array.isArray(viewer.viewHistory)) {
                    viewer.viewHistory = [];
                }

                const requestMeta = {
                    lastViewedAt: new Date(now),
                    ipAddress: req.ip || req.connection.remoteAddress,
                    userAgent: req.get('User-Agent'),
                };

                const lastViewEntry = viewer.viewHistory.find((entry) => entry?.videoId?.toString() === contentId);
                const viewCooldownMs = getViewRecountCooldownMs(duration);
                const lastViewedAtMs = lastViewEntry?.lastViewedAt
                    ? new Date(lastViewEntry.lastViewedAt).getTime()
                    : 0;
                const hasValidLastViewedAt = Number.isFinite(lastViewedAtMs) && lastViewedAtMs > 0;
                const timeSinceLastViewMs = hasValidLastViewedAt ? now - lastViewedAtMs : Infinity;
                const canCountView = !lastViewEntry || timeSinceLastViewMs >= viewCooldownMs;

                if (canCountView) {
                    const safeViews = Number.isFinite(Number(content.views))
                        ? Number(content.views)
                        : 0;
                    content.views = safeViews + 1;
                    content.averageWatchTime = content.views > 0
                        ? content.totalWatchTime / content.views
                        : 0;
                    await content.save();
                    viewCounted = true;
                }

                try {
                    await ensureUniqueContentView({
                        contentId,
                        userId,
                        now: new Date(now),
                    });
                } catch (contentViewError) {
                    console.error('⚠️ [CommunityFeed] ContentView upsert failed (non-blocking):', contentViewError.message);
                }

                if (lastViewEntry) {
                    lastViewEntry.lastViewedAt = requestMeta.lastViewedAt;
                    lastViewEntry.ipAddress = requestMeta.ipAddress;
                    lastViewEntry.userAgent = requestMeta.userAgent;
                } else {
                    viewer.viewHistory.push({
                        videoId: contentId,
                        lastViewedAt: requestMeta.lastViewedAt,
                        ipAddress: requestMeta.ipAddress,
                        userAgent: requestMeta.userAgent,
                    });
                }

                await viewer.save();
            }
        }

        const historyUser = await User.findById(userId, 'historyPaused') || {};
        if (!historyUser.historyPaused) {
            const watchPercentage = content.duration > 0
                ? Math.min(100, (watchTimeSeconds / content.duration) * 100) : 0;
            const completedWatch = watchPercentage >= 80;
            const existingHistory = await WatchHistory.findOne({ userId, contentId });
            const isNewEntry = !existingHistory;

            await WatchHistory.findOneAndUpdate(
                { userId, contentId },
                {
                    $set: {
                        contentType: content.contentType,
                        lastWatchedAt: new Date(),
                        watchPercentage: Math.max(watchPercentage, existingHistory?.watchPercentage || 0),
                        completedWatch: completedWatch || existingHistory?.completedWatch || false,
                        'contentMetadata.title': content.title,
                        'contentMetadata.tags': content.tags || [],
                        'contentMetadata.category': content.category,
                        'contentMetadata.creatorId': content.userId,
                        'contentMetadata.duration': content.duration
                    },
                    $inc: {
                        watchTime: watchTimeSeconds,
                        watchCount: 1
                    },
                    $setOnInsert: {
                        firstWatchedAt: new Date()
                    },
                    $push: {
                        sessions: {
                            $each: [{
                                startedAt: new Date(now - watchTimeMs),
                                endedAt: new Date(),
                                watchTime: watchTimeSeconds,
                                completedWatch
                            }],
                            $slice: -20
                        }
                    }
                },
                { upsert: true }
            );

            if (isNewEntry) {
                const historyCount = await WatchHistory.countDocuments({ userId });
                if (historyCount > 100) {
                    const oldest = await WatchHistory.find({ userId })
                        .sort({ lastWatchedAt: 1 })
                        .limit(historyCount - 100)
                        .select('_id');
                    await WatchHistory.deleteMany({ _id: { $in: oldest.map((h) => h._id) } });
                }
            }
        }

        return res.json({
            success: true,
            viewCounted,
            views: content.views,
            averageWatchTime: content.averageWatchTime,
            totalWatchTime: content.totalWatchTime,
        });
    } catch (error) {
        console.error('updateFeedWatchTime error:', error);
        return res.status(500).json({ error: 'Failed to update watch time' });
    }
};
