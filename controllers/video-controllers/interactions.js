import Video from "../../models/video.model.js";
import User from "../../models/user.model.js";

// In-memory cache for rate limiting (resets on server restart)
const watchRateLimit = new Map();
const viewHistoryRateLimit = new Map();

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

export const updateWatchTime = async (req, res) => {
    try {
        const videoId = req.params.id;
        const { watchTime } = req.body;
        const userId = req.user?.id;

        console.log('🔍 updateWatchTime called:', { videoId, watchTime, userId });

        if (!userId) {
            console.log('❌ No user ID found');
            return res.status(401).json({ message: "Authentication required" });
        }

        if (!watchTime || typeof watchTime !== 'number' || watchTime < 0) {
            console.log('❌ Invalid watchTime:', watchTime);
            return res.status(400).json({ message: "Invalid watch time" });
        }

        const video = await Video.findById(videoId);
        if (!video) {
            console.log('❌ Video not found:', videoId);
            return res.status(404).json({ message: "Video not found" });
        }

        console.log('✅ Found video:', video.title, 'duration:', video.duration);

        // Convert to seconds
        const watchTimeSeconds = watchTime / 1000;
        console.log('🔄 Converted watchTime to seconds:', watchTimeSeconds);

        // Constraints to reduce outliers and bot effects
        const MIN_WATCH_TIME = 5; // 5 seconds minimum
        const MAX_WATCH_TIME = video.duration ? video.duration * 1.5 : 3600; // Max 1.5x video duration or 1 hour
        const MIN_VIDEO_DURATION = 10; // Don't count very short videos

        console.log('📊 Constraints:', { MIN_WATCH_TIME, MAX_WATCH_TIME, MIN_VIDEO_DURATION, videoDuration: video.duration });

        // Skip if video is too short or watch time is invalid
        if (video.duration < MIN_VIDEO_DURATION ||
            watchTimeSeconds < MIN_WATCH_TIME ||
            watchTimeSeconds > MAX_WATCH_TIME) {
            console.log('⚠️ Watch time not counted due to constraints');
            return res.json({
                message: "Watch time not counted (invalid duration or outlier)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }

        // Check for bot-like behavior: rapid successive watches
        const recentWatchKey = `${userId}_${videoId}`;
        const now = Date.now();
        const lastWatch = watchRateLimit.get(recentWatchKey) || 0;

        if (now - lastWatch < 30000) { // Less than 30 seconds since last watch
            console.log('⚠️ Watch time not counted due to rate limiting');
            return res.json({
                message: "Watch time not counted (too frequent)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }

        // Update rate limit cache
        watchRateLimit.set(recentWatchKey, now);

        // Add to user's viewHistory if not added recently (once per hour per video)
        const viewHistoryKey = `view_${userId}_${videoId}`;
        const lastViewHistory = viewHistoryRateLimit.get(viewHistoryKey) || 0;

        if (now - lastViewHistory > 3600000) { // 1 hour
            const user = await User.findById(userId);
            if (user) {
                user.viewHistory.push({
                    videoId: videoId,
                    lastViewedAt: new Date(),
                    ipAddress: req.ip || req.connection.remoteAddress,
                    userAgent: req.get('User-Agent')
                });
                await user.save();
                viewHistoryRateLimit.set(viewHistoryKey, now);
                console.log('✅ Added to user viewHistory');
            }
        }

        // Calculate rolling average with diminishing weight for older watches
        const currentAvg = video.averageWatchTime || 0;
        const watchCount = video.watchCount || 0;

        console.log('📈 Current stats:', { currentAvg, watchCount });

        // Use exponential moving average to reduce impact of outliers
        const alpha = 0.1; // Weight for new value (10%)
        const newAverage = currentAvg * (1 - alpha) + watchTimeSeconds * alpha;

        video.averageWatchTime = Math.round(newAverage * 100) / 100; // Round to 2 decimal places
        video.watchCount = watchCount + 1;

        console.log('💾 Saving video with new stats:', { averageWatchTime: video.averageWatchTime, watchCount: video.watchCount });

        await video.save();

        console.log('✅ Watch time updated successfully');

        res.json({
            message: "Watch time updated",
            averageWatchTime: video.averageWatchTime,
            watchCount: video.watchCount
        });

    } catch (error) {
        console.error("💥 Error updating watch time:", error);
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};