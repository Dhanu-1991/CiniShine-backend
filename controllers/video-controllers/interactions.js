import Video from "../../models/video.model.js";
import User from "../../models/user.model.js";

export const likeVideo = async (req, res) => {
    try {
        const userId = req.user?.id;
        const videoId = req.params.id;

        if (!userId) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const video = await Video.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        // Initialize arrays if not exists
        if (!video.likes) video.likes = [];
        if (!video.dislikes) video.dislikes = [];

        const userObjectId = userId;
        const likedIndex = video.likes.indexOf(userObjectId);
        const dislikedIndex = video.dislikes.indexOf(userObjectId);

        if (likedIndex > -1) {
            // User already liked, remove like (unlike)
            video.likes.splice(likedIndex, 1);
            await video.save();
            return res.json({
                message: "Like removed",
                liked: false,
                likes: video.likes.length,
                dislikes: video.dislikes.length
            });
        } else {
            // Add like
            video.likes.push(userObjectId);
            // Remove dislike if exists
            if (dislikedIndex > -1) {
                video.dislikes.splice(dislikedIndex, 1);
            }
            await video.save();
            return res.json({
                message: "Video liked",
                liked: true,
                likes: video.likes.length,
                dislikes: video.dislikes.length
            });
        }

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

        const video = await Video.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        // Initialize arrays if not exists
        if (!video.likes) video.likes = [];
        if (!video.dislikes) video.dislikes = [];

        const userObjectId = userId;
        const likedIndex = video.likes.indexOf(userObjectId);
        const dislikedIndex = video.dislikes.indexOf(userObjectId);

        if (dislikedIndex > -1) {
            // User already disliked, remove dislike
            video.dislikes.splice(dislikedIndex, 1);
            await video.save();
            return res.json({
                message: "Dislike removed",
                disliked: false,
                likes: video.likes.length,
                dislikes: video.dislikes.length
            });
        } else {
            // Add dislike
            video.dislikes.push(userObjectId);
            // Remove like if exists
            if (likedIndex > -1) {
                video.likes.splice(likedIndex, 1);
            }
            await video.save();
            return res.json({
                message: "Video disliked",
                disliked: true,
                likes: video.likes.length,
                dislikes: video.dislikes.length
            });
        }

    } catch (error) {
        console.error("Error disliking video:", error);
        res.status(500).json({ message: "Internal server error" });
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

// In-memory cache for rate limiting (simple implementation for single server)
const watchRateLimitCache = new Map();

export const updateWatchTime = async (req, res) => {
    try {
        const videoId = req.params.id;
        const { watchTime } = req.body;
        const userId = req.user.id;

        const video = await Video.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        // Convert to seconds
        const watchTimeSeconds = watchTime / 1000;

        // Constraints to reduce outliers and bot effects
        const MIN_WATCH_TIME = 5; // 5 seconds minimum
        const MAX_WATCH_TIME = video.duration ? video.duration * 1.5 : 3600; // Max 1.5x video duration or 1 hour
        const MIN_VIDEO_DURATION = 10; // Don't count very short videos

        // Skip if video is too short or watch time is invalid
        if (video.duration < MIN_VIDEO_DURATION ||
            watchTimeSeconds < MIN_WATCH_TIME ||
            watchTimeSeconds > MAX_WATCH_TIME) {
            return res.json({
                message: "Watch time not counted (invalid duration or outlier)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }

        // Check for bot-like behavior: rapid successive watches
        const recentWatchKey = `${userId}_${videoId}`;
        const now = Date.now();
        const lastWatch = watchRateLimitCache.get(recentWatchKey) || 0;

        if (now - lastWatch < 30000) { // Less than 30 seconds since last watch
            return res.json({
                message: "Watch time not counted (too frequent)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }

        // Update cache for rate limiting
        watchRateLimitCache.set(recentWatchKey, now);

        // Clean up old entries periodically (simple cleanup)
        if (Math.random() < 0.01) { // 1% chance on each request
            const cutoff = now - 3600000; // Remove entries older than 1 hour
            for (const [key, timestamp] of watchRateLimitCache.entries()) {
                if (timestamp < cutoff) {
                    watchRateLimitCache.delete(key);
                }
            }
        }

        // Calculate rolling average with diminishing weight for older watches
        const currentAvg = video.averageWatchTime || 0;
        const watchCount = video.watchCount || 0;

        // Use exponential moving average to reduce impact of outliers
        const alpha = 0.1; // Weight for new value (10%)
        const newAverage = currentAvg * (1 - alpha) + watchTimeSeconds * alpha;

        video.averageWatchTime = Math.round(newAverage * 100) / 100; // Round to 2 decimal places
        video.watchCount = watchCount + 1;

        await video.save();

        res.json({
            message: "Watch time updated",
            averageWatchTime: video.averageWatchTime,
            watchCount: video.watchCount
        });

    } catch (error) {
        console.error("Error updating watch time:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};