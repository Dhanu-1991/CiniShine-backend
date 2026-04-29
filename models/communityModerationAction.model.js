import mongoose from 'mongoose';

/**
 * CommunityModerationAction Model
 * Tracks all enforcement actions taken by moderators/admins within a community.
 * Links actions to specific community rules when applicable.
 */
const CommunityModerationActionSchema = new mongoose.Schema({
    communityId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Community',
        required: true,
        index: true
    },
    actionBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    targetUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true
    },
    targetContentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
        default: null
    },
    actionType: {
        type: String,
        required: true,
        enum: [
            'content_removed',
            'member_warned',
            'member_muted',
            'member_unmuted',
            'member_banned',
            'member_removed',
            'member_role_changed',
        ],
        index: true
    },
    // Index into the community.rules array (null if action isn't rule-based)
    ruleIndex: {
        type: Number,
        default: null
    },
    // Rule title snapshot at time of action (so log is readable even if rules change)
    ruleTitle: {
        type: String,
        default: null
    },
    reason: {
        type: String,
        default: '',
        maxlength: 500
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

CommunityModerationActionSchema.index({ communityId: 1, createdAt: -1 });
CommunityModerationActionSchema.index({ communityId: 1, actionType: 1 });
CommunityModerationActionSchema.index({ targetUserId: 1, communityId: 1 });

const CommunityModerationAction = mongoose.model('CommunityModerationAction', CommunityModerationActionSchema);
export default CommunityModerationAction;
