/**
 * interactions.js — VIDEO engagement & watch time tracking
 *
 * View counting: min(30s, 30% of duration) threshold.
 * Supports both authenticated (userId) and anonymous (IP+fingerprint) viewers.
 * View counts are batched via viewCountQueue and flushed every 10s.
 * Cooldown dedup uses ContentView.lastCountedAt instead of user.viewHistory.
 */
import crypto from 'crypto';
import Content from "../../models/content.model.js";
import User from "../../models/user.model.js";
import VideoReaction from "../../models/videoReaction.model.js";
import WatchHistory from "../../models/watchHistory.model.js";
import ContentView from "../../models/contentView.model.js";
import { recordWatchSignal } from "../../utils/watchAnalytics.js";

// In-memory rate limiting (resets on server restart — acceptable for throttling)
const watchRateLimit = new Map();

export const likeVideo = async (req, res) => {
    try {
        const userId = req.user?.id;
        const videoId = req.params.id;

        if (!userId) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const video = await Content.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        const existingReaction = await VideoReaction.findOne({ videoId, userId });

        if (existingReaction) {
            if (existingReaction.type === 'like') {
                await VideoReaction.deleteOne({ _id: existingReaction._id });
                video.likeCount = Math.max(0, (video.likeCount || 1) - 1);
                await video.save();
                return res.json({
                    message: "Like removed",
                    liked: false,
                    likes: video.likeCount,
                    dislikes: video.dislikeCount,
                    userReaction: null
                });
            }

            existingReaction.type = 'like';
            await existingReaction.save();
            video.dislikeCount = Math.max(0, (video.dislikeCount || 1) - 1);
            video.likeCount = (video.likeCount || 0) + 1;
            await video.save();
            return res.json({
                message: "Changed to like",
                liked: true,
                likes: video.likeCount,
                dislikes: video.dislikeCount,
                userReaction: 'like'
            });
        }

        await VideoReaction.create({ videoId, userId, type: 'like' });
        video.likeCount = (video.likeCount || 0) + 1;
        await video.save();

        return res.json({
            message: "Liked",
            liked: true,
            likes: video.likeCount,
            dislikes: video.dislikeCount,
            userReaction: 'like'
        });
    } catch (error) {
        console.error("Error liking video:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

export const dislikeVideo = async (req, res) => {
    try {
        const userId = req.user?.id;
        const videoId = req.params.id;

        if (!userId) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const video = await Content.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        const existingReaction = await VideoReaction.findOne({ videoId, userId });

        if (existingReaction) {
            if (existingReaction.type === 'dislike') {
                await VideoReaction.deleteOne({ _id: existingReaction._id });
                video.dislikeCount = Math.max(0, (video.dislikeCount || 1) - 1);
                await video.save();
                return res.json({
                    message: "Dislike removed",
                    disliked: false,
                    likes: video.likeCount,
                    dislikes: video.dislikeCount,
                    userReaction: null
                });
            }

            existingReaction.type = 'dislike';
            await existingReaction.save();
            video.likeCount = Math.max(0, (video.likeCount || 1) - 1);
            video.dislikeCount = (video.dislikeCount || 0) + 1;
            await video.save();
            return res.json({
                message: "Changed to dislike",
                disliked: true,
                likes: video.likeCount,
                dislikes: video.dislikeCount,
                userReaction: 'dislike'
            });
        }

        await VideoReaction.create({ videoId, userId, type: 'dislike' });
        video.dislikeCount = (video.dislikeCount || 0) + 1;
        await video.save();

        return res.json({
            message: "Disliked",
            disliked: true,
            likes: video.likeCount,
            dislikes: video.dislikeCount,
            userReaction: 'dislike'
        });
    } catch (error) {
        console.error("Error disliking video:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

export const updateWatchTime = async (req, res) => {
    try {
        const videoId = req.params.id;
        const watchTimeMs = Number(req.body.watchTime);

        if (!Number.isFinite(watchTimeMs) || watchTimeMs <= 0) {
            return res.status(400).json({ message: "Invalid watch time" });
        }

        const video = await Content.findById(videoId).lean();
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        const now = new Date();
        const result = await recordWatchSignal({
            req,
            content: video,
            contentId: videoId,
            event: {
                ...req.body,
                eventId: req.body.eventId || `${videoId}-${req.body.watchSessionId || req.body.sessionId || 'legacy'}-${Date.now()}`,
                activePlayTime: watchTimeMs,
                contentDuration: video.duration || req.body.duration || 0,
                sessionId: req.body.sessionId || req.body.watchSessionId || null,
            },
            device: (req.headers['user-agent'] || '').toLowerCase().includes('mobile') ? 'mobile' : 'desktop',
            dateBucket: now.toISOString().slice(0, 10),
            monthBucket: now.toISOString().slice(0, 7),
        });

        const freshVideo = await Content.findById(videoId).select('averageWatchTime views totalWatchTime completionRate authenticatedViews anonymousViews authenticatedUniqueViewers anonymousUniqueViewers').lean();
        return res.json({
            message: "Watch time updated",
            averageWatchTime: freshVideo?.averageWatchTime || 0,
            views: freshVideo?.views || 0,
            totalWatchTime: freshVideo?.totalWatchTime || 0,
            completionRate: freshVideo?.completionRate ?? null,
            authenticatedViews: freshVideo?.authenticatedViews || 0,
            anonymousViews: freshVideo?.anonymousViews || 0,
            authenticatedUniqueViewers: freshVideo?.authenticatedUniqueViewers || 0,
            anonymousUniqueViewers: freshVideo?.anonymousUniqueViewers || 0,
            viewCounted: result.viewCounted,
            duplicate: result.duplicate,
        });
    } catch (error) {
        console.error("Error updating watch time:", error);
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

export const subscribeToUser = async (req, res) => {
    try {
        const userId = req.user?.id;
        const targetUserId = req.params.userId;

        const user = await User.findById(userId);
        const targetUser = await User.findById(targetUserId);

        if (!user || !targetUser) {
            return res.status(404).json({ message: "User not found" });
        }

        // Initialize subscriptions array if not exists
        if (!user.subscriptions) {
            user.subscriptions = [];
        }

        // Check if already subscribed
        const isSubscribed = user.subscriptions.includes(targetUserId);

        if (isSubscribed) {
            // Unsubscribe
            user.subscriptions = user.subscriptions.filter(id => id.toString() !== targetUserId);
            await user.save();

            res.json({
                message: "Unsubscribed successfully",
                subscribed: false,
                subscriberCount: user.subscriptions.length
            });
        } else {
            // Subscribe
            user.subscriptions.push(targetUserId);
            await user.save();

            res.json({
                message: "Subscribed successfully",
                subscribed: true,
                subscriberCount: user.subscriptions.length
            });
        }

    } catch (error) {
        console.error("Error subscribing:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};
