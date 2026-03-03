import mongoose from 'mongoose';

/**
 * CommunityMember Model
 * Tracks membership in communities with roles, status, and join source.
 */
const CommunityMemberSchema = new mongoose.Schema({
    communityId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Community',
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    role: {
        type: String,
        enum: ['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'PENDING', 'BANNED'],
        default: 'MEMBER'
    },
    status: {
        type: String,
        enum: ['ACTIVE', 'PENDING', 'BANNED'],
        default: 'ACTIVE'
    },
    joinedAt: {
        type: Date,
        default: Date.now
    },
    joinSource: {
        type: String,
        enum: ['manual', 'invite', 'request', 'import_backfill'],
        default: 'manual'
    }
}, {
    timestamps: true
});

// Unique constraint: one membership per user per community
CommunityMemberSchema.index({ communityId: 1, userId: 1 }, { unique: true });
CommunityMemberSchema.index({ communityId: 1, status: 1 });
CommunityMemberSchema.index({ userId: 1, status: 1 });
CommunityMemberSchema.index({ joinedAt: 1 });

const CommunityMember = mongoose.model('CommunityMember', CommunityMemberSchema);
export default CommunityMember;
