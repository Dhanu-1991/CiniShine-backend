import Video from "../../models/video.model.js";
import mongoose from 'mongoose';

const updateViews = async (videoId) => {
    try {
        console.log("📊 updateViews called for:", videoId);

        // Validate videoId
        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            throw new Error("Invalid video ID format");
        }

        const video = await Video.findById(videoId);
        if (!video) {
            throw new Error("Video not found");
        }

        video.views = (video.views || 0) + 1;
        
        video.lastViewedAt = new Date();

        // Add entry to viewHistory with current timestamp
        video.viewHistory.push({
            lastViewedAt: new Date(),
        });

        await video.save();

        console.log(`✅ View count updated: ${video.views} views | Last viewed: ${video.lastViewedAt}`);
        return video;
    } catch (error) {
        console.error("❌ Error updating view count:", error);
        throw error;
    }
};

export { updateViews };