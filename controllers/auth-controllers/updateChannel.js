import User from "../../models/user.model.js";

export const updateChannel = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { channelName, channelDescription } = req.body;

        if (!channelName || !channelName.trim()) {
            return res.status(400).json({ message: "Channel name is required" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Check if channel name is unique (case insensitive)
        const existingUser = await User.findOne({
            channelName: { $regex: new RegExp(`^${channelName.trim()}$`, 'i') },
            _id: { $ne: userId }
        });

        if (existingUser) {
            return res.status(400).json({ message: "Channel name already taken" });
        }

        // Update channel info
        user.channelName = channelName.trim();
        user.channelDescription = channelDescription ? channelDescription.trim() : "";
        await user.save();

        console.log("Channel updated for user:", userId, { channelName: user.channelName });

        return res.status(200).json({
            message: "Channel updated successfully",
            user: {
                _id: user._id,
                channelName: user.channelName,
                channelDescription: user.channelDescription
            }
        });

    } catch (error) {
        console.error("Error updating channel:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};