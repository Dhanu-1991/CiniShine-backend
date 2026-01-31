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
    getFeedContent
} from '../../controllers/content-controllers/contentController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

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
// GET ROUTES
// ============================================
// Get feed (public shorts, audio, posts)
router.get('/feed', getFeedContent);

// Get user's own content
router.get('/user/my-content', universalTokenVerifier, getUserContent);

// Get specific content by ID
router.get('/:id', universalTokenVerifier, getContent);

export default router;
