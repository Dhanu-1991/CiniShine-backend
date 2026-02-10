import Content from "../../models/content.model.js";
import User from "../../models/user.model.js";
import mongoose from 'mongoose';

// Async view update - non-blocking, fire and forget
const updateViewsAsync = async (videoId, userId, ipAddress, userAgent) => {
    try {
        console.log("📊 updateViewsAsync called for:", videoId, "by user:", userId);

        // Validate videoId
        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            throw new Error("Invalid video ID format");
        }

        const video = await Content.findById(videoId);
        if (!video) {
            throw new Error("Video not found");
        }

        video.views = (video.views || 0) + 1;
        video.lastViewedAt = new Date();
        await video.save();

        // Update user's viewHistory if userId is provided
        if (userId && mongoose.Types.ObjectId.isValid(userId)) {
            const user = await User.findById(userId);
            if (user) {
                user.viewHistory.push({
                    videoId: videoId,
                    lastViewedAt: new Date(),
                    ipAddress: ipAddress,
                    userAgent: userAgent
                });
                await user.save();
                console.log(`✅ User's viewHistory updated for user: ${userId}`);
            }
        }

        console.log(`✅ View count updated: ${video.views} views | Last viewed: ${video.lastViewedAt}`);
        return video;
    } catch (error) {
        console.error("❌ Error updating view count:", error);
        // Don't throw - this is async and shouldn't block the response
    }
};

// Synchronous view update (blocking)
const updateViews = async (videoId, userId, ipAddress, userAgent) => {
    try {
        console.log("📊 updateViews called for:", videoId, "by user:", userId);

        // Validate videoId
        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            throw new Error("Invalid video ID format");
        }

        const video = await Content.findById(videoId);
        if (!video) {
            throw new Error("Video not found");
        }

        video.views = (video.views || 0) + 1;
        video.lastViewedAt = new Date();
        await video.save();

        // Update user's viewHistory if userId is provided
        if (userId && mongoose.Types.ObjectId.isValid(userId)) {
            const user = await User.findById(userId);
            if (user) {
                user.viewHistory.push({
                    videoId: videoId,
                    lastViewedAt: new Date(),
                    ipAddress: ipAddress,
                    userAgent: userAgent
                });
                await user.save();
                console.log(`✅ User's viewHistory updated for user: ${userId}`);
            }
        }

        console.log(`✅ View count updated: ${video.views} views | Last viewed: ${video.lastViewedAt}`);
        return video;
    } catch (error) {
        console.error("❌ Error updating view count:", error);
        throw error;
    }
};

export { updateViews, updateViewsAsync };
