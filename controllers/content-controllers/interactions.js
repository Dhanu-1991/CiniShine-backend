import Content from "../../models/content.model.js";
import User from "../../models/user.model.js";
import VideoReaction from "../../models/videoReaction.model.js";

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

        const video = await Content.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        // Check if user already has a reaction - O(log N) indexed lookup
        const existingReaction = await VideoReaction.findOne({
            videoId,
            userId
        });

        if (existingReaction) {
            if (existingReaction.type === 'like') {
                // User already liked, remove like (unlike)
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
            } else {
                // User disliked before, change to like
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
        } else {
            // Add new like
            await VideoReaction.create({
                videoId,
                userId,
                type: 'like'
            });
            video.likeCount = (video.likeCount || 0) + 1;
            await video.save();
            return res.json({
                message: "Video liked",
                liked: true,
                likes: video.likeCount,
                dislikes: video.dislikeCount,
                userReaction: 'like'
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

        const video = await Content.findById(videoId);
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        // Check if user already has a reaction - O(log N) indexed lookup
        const existingReaction = await VideoReaction.findOne({
            videoId,
            userId
        });

        if (existingReaction) {
            if (existingReaction.type === 'dislike') {
                // User already disliked, remove dislike
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
            } else {
                // User liked before, change to dislike
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
        } else {
            // Add new dislike
            await VideoReaction.create({
                videoId,
                userId,
                type: 'dislike'
            });
            video.dislikeCount = (video.dislikeCount || 0) + 1;
            await video.save();
            return res.json({
                message: "Video disliked",
                disliked: true,
                likes: video.likeCount,
                dislikes: video.dislikeCount,
                userReaction: 'dislike'
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

        const video = await Content.findById(videoId);
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
            console.log('⚠️ Watch time not counted due to constraints - video too short or watch time outlier');
            console.log('📊 Skipped update details:', {
                videoDuration: video.duration,
                watchTimeSeconds,
                minDuration: MIN_VIDEO_DURATION,
                minWatch: MIN_WATCH_TIME,
                maxWatch: MAX_WATCH_TIME
            });
            return res.json({
                message: "Watch time not counted (invalid duration or outlier)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }

        // Check for bot-like behavior: rapid successive watches
        const recentWatchKey = `${userId}_${videoId}`;
        const now = Date.now();
        const cacheEntry = watchRateLimit.get(recentWatchKey) || { lastWatch: 0, viewCounted: false };

        if (now - cacheEntry.lastWatch < 30000) { // Less than 30 seconds since last watch
            console.log('⚠️ Watch time not counted due to rate limiting - too frequent updates');
            console.log('📊 Rate limit details:', {
                timeSinceLastWatch: now - cacheEntry.lastWatch,
                limit: 30000,
                userId,
                videoId
            });
            return res.json({
                message: "Watch time not counted (too frequent)",
                averageWatchTime: video.averageWatchTime || 0
            });
        }

        // Update rate limit cache
        watchRateLimit.set(recentWatchKey, { lastWatch: now, viewCounted: cacheEntry.viewCounted });

        // Update total watch time
        console.log('📊 Before update:', {
            currentTotalWatchTime: video.totalWatchTime || 0,
            currentViews: video.views || 0,
            currentAverageWatchTime: video.averageWatchTime || 0,
            incomingWatchTimeSeconds: watchTimeSeconds
        });

        video.totalWatchTime = (video.totalWatchTime || 0) + watchTimeSeconds;

        console.log('💾 Saving video with updated stats:', {
            newTotalWatchTime: video.totalWatchTime,
            newViews: video.views,
            newAverageWatchTime: video.averageWatchTime,
            calculation: `${video.totalWatchTime} / ${video.views || 0} = ${video.averageWatchTime}`
        });

        await video.save();

        // View counting logic
        const duration = video.duration || 0;
        let threshold;
        if (duration < 10) {
            threshold = 2; // For very short videos, require 2 seconds watch time
        } else if (duration <= 60) {
            threshold = 5; // For videos 10s to 1min, require 5 seconds
        } else {
            threshold = 15; // For videos >1min, require 15 seconds
        }

        console.log('📊 View counting check:', { watchTimeSeconds, threshold, duration, viewCounted: cacheEntry.viewCounted });

        if (watchTimeSeconds >= threshold && !cacheEntry.viewCounted) {
            console.log('✅ Threshold met, checking user and last view...');
            const user = await User.findById(userId);
            if (user) {
                console.log('✅ User found, checking last view entry...');
                const lastViewEntry = user.viewHistory.find(v => v.videoId.toString() === videoId);
                let canCountView = true;

                if (lastViewEntry) {
                    const timeSinceLastView = now - new Date(lastViewEntry.lastViewedAt).getTime();
                    console.log('📊 Last view found, time since:', timeSinceLastView / 1000, 'seconds');
                    if (duration >= 60 && duration <= 600) { // 1-10 minutes
                        if (timeSinceLastView < 60 * 1000) { // Less than 1 minute
                            canCountView = false;
                            console.log('⚠️ View not counted - too soon after last view (1min limit)');
                        }
                    } else if (duration > 600) { // >10 minutes
                        if (timeSinceLastView < 30 * 60 * 1000) { // Less than 30 minutes
                            canCountView = false;
                            console.log('⚠️ View not counted - too soon after last view (30min limit)');
                        }
                    }
                } else {
                    console.log('📊 No last view entry found, can count view');
                }

                if (canCountView) {
                    console.log('✅ Counting view...');
                    video.views = (video.views || 0) + 1;
                    video.averageWatchTime = video.totalWatchTime / video.views;

                    if (lastViewEntry) {
                        lastViewEntry.lastViewedAt = new Date();
                        lastViewEntry.ipAddress = req.ip || req.connection.remoteAddress;
                        lastViewEntry.userAgent = req.get('User-Agent');
                    } else {
                        user.viewHistory.push({
                            videoId: videoId,
                            lastViewedAt: new Date(),
                            ipAddress: req.ip || req.connection.remoteAddress,
                            userAgent: req.get('User-Agent')
                        });
                    }

                    await user.save();
                    await video.save();

                    // Mark as counted in cache
                    const updatedCache = watchRateLimit.get(recentWatchKey);
                    if (updatedCache) {
                        updatedCache.viewCounted = true;
                    }

                    console.log('✅ View counted successfully');
                    console.log('📊 View stats:', {
                        newViews: video.views,
                        newAverageWatchTime: video.averageWatchTime,
                        videoId,
                        userId
                    });
                } else {
                    console.log('⚠️ View not counted due to time restrictions');
                }
            } else {
                console.log('❌ User not found for view counting');
            }
        } else {
            console.log('⚠️ View not counted - threshold not met or already counted');
        }

        console.log('✅ Watch time updated successfully');
        console.log('📊 Final stats:', {
            totalWatchTime: video.totalWatchTime,
            views: video.views,
            averageWatchTime: video.averageWatchTime,
            videoId,
            userId
        });

        res.json({
            message: "Watch time updated",
            averageWatchTime: video.averageWatchTime,
            views: video.views,
            totalWatchTime: video.totalWatchTime
        });

    } catch (error) {
        console.error("💥 Error updating watch time:", error);
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};
