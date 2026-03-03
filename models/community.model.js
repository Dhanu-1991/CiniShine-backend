import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * Community Model
 * Supports PUBLIC and PRIVATE communities with configurable posting policies,
 * content import from creator channels, and visibility/backfill rules.
 */
const CommunitySchema = new mongoose.Schema({
    communityId: {
        type: String,
        unique: true,
        sparse: true,
        trim: true,
        lowercase: true,
        maxlength: 60
    },
    name: {
        type: String,
        required: [true, 'Community name is required'],
        unique: true,
        trim: true,
        maxlength: 100
    },
    slug: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        maxlength: 120
    },
    description: {
        type: String,
        trim: true,
        maxlength: 2000
    },
    type: {
        type: String,
        enum: ['PUBLIC', 'PRIVATE'],
        required: [true, 'Community type is required']
    },
    ownerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    avatarUrl: {
        type: String,
        trim: true
    },
    bannerUrl: {
        type: String,
        trim: true
    },
    isSearchVisible: {
        type: Boolean,
        default: true
    },
    postingPolicy: {
        type: String,
        enum: ['ANY_MEMBER', 'ADMINS_ONLY', 'MODS_AND_ADMINS', 'OWNER_ONLY'],
        default: 'ANY_MEMBER'
    },
    // Import tracking
    importedContentFlag: {
        type: Boolean,
        default: false
    },
    importedVisibility: {
        type: String,
        enum: ['VISIBLE_TO_ALL', 'MEMBERS_ONLY', 'NO_BACKFILL'],
        default: null
    },
    importEventId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'CommunityImportEvent'
    },
    importedAt: {
        type: Date,
        default: null
    },
    // Extensible settings
    settings: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    // Cached counts
    memberCount: {
        type: Number,
        default: 1
    },
    contentCount: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true
});

CommunitySchema.index({ communityId: 1 });
CommunitySchema.index({ slug: 1 });
CommunitySchema.index({ type: 1, isSearchVisible: 1 });
CommunitySchema.index({ ownerId: 1 });
CommunitySchema.index({ createdAt: -1 });

// Auto-generate communityId before save if not set
CommunitySchema.pre('save', function (next) {
    if (!this.communityId) {
        const base = this.name
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 40);
        this.communityId = `${base}_${crypto.randomBytes(4).toString('hex')}`;
    }
    next();
});

const Community = mongoose.model('Community', CommunitySchema);
export default Community;
