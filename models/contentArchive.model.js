import mongoose from 'mongoose';

const ContentArchiveSchema = new mongoose.Schema({
    content_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
        required: true
    },
    // Snapshot of S3 keys for deletion after 24h
    originalKey: String,
    hlsMasterKey: String,
    thumbnailKey: String,
    imageKey: String,
    imageKeys: [String],
    hlsPrefix: String, // e.g. hls/videos/{userId}/{contentId}/
    // Content metadata snapshot
    content_snapshot: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    removed_by_admin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        required: true
    },
    removed_at: {
        type: Date,
        default: Date.now
    },
    delete_scheduled_at: {
        type: Date,
        required: true
    },
    restored_by_admin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    restored_at: {
        type: Date,
        default: null
    },
    permanently_deleted: {
        type: Boolean,
        default: false
    },
    permanently_deleted_at: {
        type: Date,
        default: null
    },
    reason: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: ''
    }
}, { timestamps: true });

ContentArchiveSchema.index({ delete_scheduled_at: 1, permanently_deleted: 1, restored_at: 1 });
ContentArchiveSchema.index({ content_id: 1 });
ContentArchiveSchema.index({ removed_by_admin: 1 });

const ContentArchive = mongoose.model('ContentArchive', ContentArchiveSchema);
export default ContentArchive;
