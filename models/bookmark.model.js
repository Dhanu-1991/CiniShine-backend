import mongoose from 'mongoose';

/**
 * Bookmark Model
 * Stores user bookmarks grouped by content type (video, short, audio, post).
 * One bookmark per user+content pair (compound unique index).
 */
const BookmarkSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    contentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Content',
        required: true,
        index: true
    },
    contentType: {
        type: String,
        enum: ['video', 'short', 'audio', 'post'],
        required: true,
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// One bookmark per user per content item
BookmarkSchema.index({ userId: 1, contentId: 1 }, { unique: true });
// Efficient paginated queries by type
BookmarkSchema.index({ userId: 1, contentType: 1, createdAt: -1 });

const Bookmark = mongoose.model('Bookmark', BookmarkSchema);
export default Bookmark;
