import mongoose from 'mongoose';

/**
 * CommunityImportEvent Model
 * Records each content import event for audit and backfill calculations.
 */
const CommunityImportEventSchema = new mongoose.Schema({
    communityId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Community',
        required: true,
        index: true
    },
    importedByUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    importedAt: {
        type: Date,
        default: Date.now
    },
    importedCount: {
        type: Number,
        required: true,
        default: 0
    },
    visibility: {
        type: String,
        enum: ['VISIBLE_TO_ALL', 'MEMBERS_ONLY', 'NO_BACKFILL'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed'],
        default: 'completed'
    },
    error: String
}, {
    timestamps: true
});

CommunityImportEventSchema.index({ communityId: 1, importedAt: -1 });

const CommunityImportEvent = mongoose.model('CommunityImportEvent', CommunityImportEventSchema);
export default CommunityImportEvent;
