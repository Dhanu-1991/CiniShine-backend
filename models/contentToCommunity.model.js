import mongoose from 'mongoose';

/**
 * ContentToCommunity Model
 * Links content to communities. A single content item can belong to multiple communities.
 * Tracks whether the link was created via import or direct posting.
 */
const ContentToCommunitySchema = new mongoose.Schema({
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
        required: true,
        index: true
    },
    communityId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Community',
        required: true,
        index: true
    },
    isImported: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Unique constraint: one link per content per community
ContentToCommunitySchema.index({ contentId: 1, communityId: 1 }, { unique: true });
ContentToCommunitySchema.index({ communityId: 1, createdAt: -1 });
ContentToCommunitySchema.index({ communityId: 1, isImported: 1 });

const ContentToCommunity = mongoose.model('ContentToCommunity', ContentToCommunitySchema);
export default ContentToCommunity;
