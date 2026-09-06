import mongoose from 'mongoose';

const platformSettingsSchema = new mongoose.Schema({
    autoGenerateThumbnails: {
        type: Boolean,
        default: false, // Default is OFF: thumbnails are compulsory
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

// Singleton pattern: always get/create the single settings document
platformSettingsSchema.statics.getSettings = async function() {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({ autoGenerateThumbnails: false });
    }
    return settings;
};

const PlatformSettings = mongoose.model('PlatformSettings', platformSettingsSchema);
export default PlatformSettings;
