import mongoose from 'mongoose';

const referralSettingsSchema = new mongoose.Schema({
    isEnabled: {
        type: Boolean,
        default: true,
    },
    referrerBonusAmount: {
        type: Number,
        default: 25,
        min: 0,
    },
    referredBonusAmount: {
        type: Number,
        default: 25,
        min: 0,
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
referralSettingsSchema.statics.getSettings = async function() {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

const ReferralSettings = mongoose.model('ReferralSettings', referralSettingsSchema);
export default ReferralSettings;
