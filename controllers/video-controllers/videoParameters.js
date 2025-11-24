import Video from "../../models/video.model.js";
import mongoose from 'mongoose';

const updateViewCount = async (videoId) => {
  try {
    // Validate videoId
    if (!mongoose.Types.ObjectId.isValid(videoId)) {
      throw new Error("Invalid video ID");
    }


    const video = await Video.findById(videoId);
    if (!video) {
      throw new Error("Video not found");
    }

    video.viewCount = (video.viewCount || 0) + 1;
    await video.save();
  } catch (error) {
    console.error("Error updating view count:", error);
  }
};

export { updateViewCount };