import User from "../../models/user.model.js";

/**
 * Generate a handle from a channel name
 * e.g. "My Cool Channel" → "my_cool_channel"
 */
export function generateHandle(channelName) {
    if (!channelName) return "";
    const trimmed = channelName.trim();
    // Replace spaces with underscores, remove non-alphanumeric/underscore chars
    let handle = trimmed
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '');
    // Ensure it starts with a letter
    if (handle && !/^[a-zA-Z]/.test(handle)) {
        handle = 'ch_' + handle;
    }
    return handle.toLowerCase();
}

/**
 * Make a handle unique by appending a number if needed
 */
async function makeHandleUnique(baseHandle, excludeUserId = null) {
    let handle = baseHandle;
    let suffix = 0;
    while (true) {
        const query = { channelHandle: handle };
        if (excludeUserId) query._id = { $ne: excludeUserId };
        const exists = await User.findOne(query);
        if (!exists) return handle;
        suffix++;
        handle = `${baseHandle}${suffix}`;
    }
}

/**
 * PUT /api/v1/auth/authRoutes/update-channel
 * Create or update channel with name + handle
 */
export const updateChannel = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { channelName, channelDescription, channelHandle } = req.body;

        if (!channelName || !channelName.trim()) {
            return res.status(400).json({ message: "Channel name is required" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Check if channel name is unique (case insensitive)
        const existingUser = await User.findOne({
            channelName: { $regex: new RegExp(`^${channelName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
            _id: { $ne: userId }
        });

        if (existingUser) {
            return res.status(400).json({ message: "Channel name already taken" });
        }

        // Handle: use provided or generate from channel name
        let finalHandle;
        if (channelHandle && channelHandle.trim()) {
            const cleaned = channelHandle.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
            if (cleaned.length < 3) {
                return res.status(400).json({ message: "Handle must be at least 3 characters" });
            }
            const handleTaken = await User.findOne({
                channelHandle: cleaned,
                _id: { $ne: userId }
            });
            if (handleTaken) {
                return res.status(400).json({ message: "Handle already taken" });
            }
            finalHandle = cleaned;
        } else {
            const base = generateHandle(channelName);
            finalHandle = await makeHandleUnique(base, userId);
        }

        // Update channel info
        user.channelName = channelName.trim();
        user.channelHandle = finalHandle;
        user.channelDescription = channelDescription ? channelDescription.trim() : "";
        await user.save();

        console.log("Channel updated for user:", userId, { channelName: user.channelName, channelHandle: user.channelHandle });

        return res.status(200).json({
            message: "Channel updated successfully",
            user: {
                _id: user._id,
                channelName: user.channelName,
                channelHandle: user.channelHandle,
                channelDescription: user.channelDescription
            }
        });

    } catch (error) {
        console.error("Error updating channel:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/v1/auth/authRoutes/check-handle?handle=xxx
 * Real-time handle availability check
 */
export const checkHandleAvailability = async (req, res) => {
    try {
        const { handle } = req.query;
        const userId = req.user?.id;

        if (!handle || handle.trim().length < 3) {
            return res.status(400).json({ available: false, message: "Handle must be at least 3 characters" });
        }

        const cleaned = handle.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (cleaned !== handle.trim().toLowerCase()) {
            return res.status(400).json({ available: false, message: "Handle can only contain letters, numbers, and underscores" });
        }

        const query = { channelHandle: cleaned };
        if (userId) query._id = { $ne: userId };

        const exists = await User.findOne(query);
        return res.status(200).json({
            available: !exists,
            handle: cleaned,
            message: exists ? "Handle already taken" : "Handle is available"
        });
    } catch (error) {
        console.error("Error checking handle:", error);
        return res.status(500).json({ available: false, message: "Internal server error" });
    }
};

/**
 * GET /api/v1/auth/authRoutes/generate-handle?channelName=xxx
 * Generate a unique handle suggestion from channel name
 */
export const generateHandleSuggestion = async (req, res) => {
    try {
        const { channelName } = req.query;
        const userId = req.user?.id;

        if (!channelName || !channelName.trim()) {
            return res.status(400).json({ message: "Channel name is required" });
        }

        const base = generateHandle(channelName);
        const handle = await makeHandleUnique(base, userId);

        return res.status(200).json({ handle });
    } catch (error) {
        console.error("Error generating handle:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};