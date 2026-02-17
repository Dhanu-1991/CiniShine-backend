/**
 * Bookmark Router - /api/v2/bookmarks
 */
import express from 'express';
import {
    toggleBookmark,
    getBookmarkStatus,
    getBookmarksByType,
    getAllBookmarks,
    removeBookmark
} from '../../controllers/bookmark-controllers/bookmarkController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// All bookmark routes require authentication
router.use(universalTokenVerifier);

// Toggle bookmark (add/remove)
router.post('/', toggleBookmark);

// Get bookmark counts by type
router.get('/', getAllBookmarks);

// Check bookmark status for a specific content
router.get('/status/:contentId', getBookmarkStatus);

// Get bookmarks by type (paginated)
router.get('/:type', getBookmarksByType);

// Remove a bookmark
router.delete('/:contentId', removeBookmark);

export default router;
