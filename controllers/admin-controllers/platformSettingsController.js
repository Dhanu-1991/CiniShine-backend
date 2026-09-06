import PlatformSettings from '../../models/platformSettings.model.js';

export const getPlatformSettings = async (req, res) => {
    try {
        const settings = await PlatformSettings.getSettings();
        return res.status(200).json({
            success: true,
            settings: {
                autoGenerateThumbnails: settings.autoGenerateThumbnails,
                updatedAt: settings.updatedAt,
            }
        });
    } catch (error) {
        console.error('Error fetching platform settings:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

export const updatePlatformSettings = async (req, res) => {
    try {
        const { autoGenerateThumbnails } = req.body;
        const settings = await PlatformSettings.getSettings();

        if (typeof autoGenerateThumbnails === 'boolean') {
            settings.autoGenerateThumbnails = autoGenerateThumbnails;
        }
        settings.updatedBy = req.admin?._id || req.admin?.id;
        settings.updatedAt = new Date();
        await settings.save();

        return res.status(200).json({
            success: true,
            message: 'Platform settings updated successfully',
            settings: {
                autoGenerateThumbnails: settings.autoGenerateThumbnails,
                updatedAt: settings.updatedAt,
            }
        });
    } catch (error) {
        console.error('Error updating platform settings:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
