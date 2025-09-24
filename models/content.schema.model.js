import mongoose from "mongoose";

const ContentSchema = new mongoose.Schema({
    creatorId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    type: { type: String, enum: ['video', 'post'], default: 'video' },
    title: String,
    description: String,
    tags: [String],               // simple tags
    language: String,
    durationSeconds: Number,
    sizeBytes: Number,
    storageKey: String,           // s3 key for original file
    renditions: [{ key: String, resolution: String, size: Number }], // after transcode
    thumbnailKey: String,
    uploadedAt: { type: Date, default: Date.now },
    publishedAt: Date,
    status: { type: String, default: 'uploading' }, // uploading, processing, ready
    extra: { type: Schema.Types.Mixed, default: {} }
});
ContentSchema.index({ tags: 1 });
ContentSchema.index({ publishedAt: -1 });


ContentSchema = mongoose.model("Content", ContentSchema);
export default ContentSchema;
