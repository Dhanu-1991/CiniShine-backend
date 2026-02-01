/**
 * Content Router
 * Routes for shorts, audio, and posts
 */

import express from 'express';
import multer from 'multer';
import {
    // Shorts
    shortUploadInit,
    shortUploadComplete,
    // Audio
    audioUploadInit,
    audioUploadComplete,
    // Posts
    postImageInit,
    createPost,
    // Thumbnail
    uploadThumbnail,
    // Get content
    getContent,
    getUserContent,
    getFeedContent,
    // New endpoints
    updateContentWatchTime,
    updateContentEngagement,
    getContentEngagementStatus,
    getShortsPlayerFeed,
    getAudioPlayerFeed,
    getSingleContent
} from '../../controllers/content-controllers/contentController.js';
import { universalTokenVerifier, optionalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Configure multer for thumbnail uploads (in-memory)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB max for thumbnails
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// ============================================
// SHORTS ROUTES
// ============================================
router.post('/short/init', universalTokenVerifier, shortUploadInit);
router.post('/short/complete', universalTokenVerifier, shortUploadComplete);

// ============================================
// AUDIO ROUTES
// ============================================
router.post('/audio/init', universalTokenVerifier, audioUploadInit);
router.post('/audio/complete', universalTokenVerifier, audioUploadComplete);

// ============================================
// POST ROUTES
// ============================================
router.post('/post/init', universalTokenVerifier, postImageInit);
router.post('/post/create', universalTokenVerifier, createPost);

// ============================================
// THUMBNAIL ROUTE (for any content type)
// ============================================
router.post('/:id/thumbnail', universalTokenVerifier, upload.single('thumbnail'), uploadThumbnail);

// ============================================
// PLAYER FEEDS (for dedicated players)
// ============================================
// Shorts player feed (vertical scrolling like YouTube Shorts)
router.get('/shorts/feed', universalTokenVerifier, getShortsPlayerFeed);

// Audio player feed
router.get('/audio/feed', universalTokenVerifier, getAudioPlayerFeed);

// ============================================
// WATCH TIME & ENGAGEMENT TRACKING
// ============================================
router.post('/:id/watch-time', universalTokenVerifier, updateContentWatchTime);
router.post('/:id/engagement', universalTokenVerifier, updateContentEngagement);
router.get('/:id/engagement-status', optionalTokenVerifier, getContentEngagementStatus);

// ============================================
// GET ROUTES
// ============================================
// Get feed (public shorts, audio, posts)
router.get('/feed', getFeedContent);

// Get user's own content
router.get('/user/my-content', universalTokenVerifier, getUserContent);

// Get single content by ID (with all URLs)
router.get('/single/:id', getSingleContent);

// ============================================
// COMMENTS ROUTES (for shorts, audio, posts)
// ============================================
import commentRouter from '../commentRoutes/commentRouter.js';

// Mount comment routes for content
// POST /api/v2/content/:id/comments - Create comment
// GET /api/v2/content/:id/comments - Get comments
// Use a middleware function that explicitly handles the mapping
const mapContentIdToVideoId = (req, res, next) => {
    // req.params should have 'id' from the /:id/comments route
    if (req.params.id) {
        req.params.videoId = req.params.id;
        req.params.contentId = req.params.id;
        console.log(`🔗 [ContentRouter] Mapping id (${req.params.id}) to videoId for comments route`);
    } else {
        console.error(`❌ [ContentRouter] No id param found in route`);
    }
    next();
};

router.use('/:id/comments', mapContentIdToVideoId, commentRouter);

// Get specific content by ID (legacy)
router.get('/:id', universalTokenVerifier, getContent);

export default router;
