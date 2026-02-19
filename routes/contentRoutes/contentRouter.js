/**
 * Content Router
 * Routes for shorts, audio, posts, and shared content operations
 * Mounts sub-routers for each content type
 */

import express from 'express';
import multer from 'multer';

// Sub-routers
import shortsRouter from './shortsRouter.js';
import audioRouter from './audioRouter.js';
import postsRouter from './postsRouter.js';

// Shared content controllers
import {
    uploadThumbnail,
    getContent,
    getUserContent,
    getFeedContent,
    getSingleContent,
    updateContentWatchTime,
    updateContentEngagement,
    getContentEngagementStatus
} from '../../controllers/content-controllers/sharedContentController.js';

// Shorts feed (also mounted via sub-router, kept for backward compat)
import { getShortsPlayerFeed } from '../../controllers/content-controllers/shortsController.js';
import { getAudioPlayerFeed } from '../../controllers/content-controllers/audioController.js';
import { getSubscriptionPosts } from '../../controllers/content-controllers/postsController.js';

import { multipartInit, multipartComplete, multipartAbort } from '../../controllers/content-controllers/multipartUploadController.js';
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
// MULTIPART UPLOAD ROUTES (fast parallel chunked uploads)
// ============================================
router.post('/upload/multipart/init', universalTokenVerifier, multipartInit);
router.post('/upload/multipart/complete', universalTokenVerifier, multipartComplete);
router.post('/upload/multipart/abort', universalTokenVerifier, multipartAbort);

// ============================================
// MOUNT SUB-ROUTERS
// ============================================
router.use('/short', shortsRouter);
router.use('/audio', audioRouter);
router.use('/post', postsRouter);

// ============================================
// THUMBNAIL ROUTE (for any content type)
// ============================================
router.post('/:id/thumbnail', universalTokenVerifier, upload.single('thumbnail'), uploadThumbnail);

// ============================================
// PLAYER FEEDS (also accessible at root level)
// ============================================
router.get('/shorts/feed', optionalTokenVerifier, getShortsPlayerFeed);
router.get('/audio/feed', optionalTokenVerifier, getAudioPlayerFeed);
router.get('/posts/feed', optionalTokenVerifier, getSubscriptionPosts);

// ============================================
// ENGAGEMENT ROUTES (like/dislike for shorts, audio, posts)
// ============================================
router.post('/:id/engagement', universalTokenVerifier, updateContentEngagement);
router.get('/:id/engagement/status', universalTokenVerifier, getContentEngagementStatus);
router.post('/:id/watch-time', universalTokenVerifier, updateContentWatchTime);

// ============================================
// GET ROUTES
// ============================================
// Get feed (public shorts, audio, posts)
router.get('/feed', getFeedContent);

// Get user's own content// ============================================

router.get('/user/my-content', universalTokenVerifier, getUserContent);

// Get single content by ID (with all URLs)
router.get('/single/:id', getSingleContent);

// ============================================
// COMMENTS ROUTES (for shorts, audio, posts)
// ============================================
import commentRouter from '../commentRoutes/commentRouter.js';

// Mount comment routes for content
// POST /api/v2/content/:videoId/comments - Create comment (use :videoId to match commentRouter expectation)
// GET /api/v2/content/:videoId/comments - Get comments
// Using :videoId directly so mergeParams works correctly with commentRouter
router.use('/:videoId/comments', commentRouter);

// Get specific content by ID (legacy)
router.get('/:id', optionalTokenVerifier, getContent);

export default router;
