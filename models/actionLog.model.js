import mongoose from 'mongoose';

/**
 * ActionLog Model
 * Audit trail for all community-related actions.
 */
const ActionLogSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    communityId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Community',
        index: true
    },
    action: {
        type: String,
        required: true,
        index: true
    },
    payload: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

ActionLogSchema.index({ communityId: 1, createdAt: -1 });
ActionLogSchema.index({ userId: 1, action: 1 });

const ActionLog = mongoose.model('ActionLog', ActionLogSchema);
export default ActionLog;
