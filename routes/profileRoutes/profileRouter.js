/**
 * Profile Router - /api/v2/profile
 * Creator profile management routes (all require authentication)
 */

import express from 'express';
import multer from 'multer';
import {
    getMyContent,
    updateContent,
    deleteContent,
    deleteComment,
    updateProfileSettings,
    getProfileSettings,
    getContentAnalytics,
} from '../../controllers/profile-controllers/profileController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Profile settings
router.get('/settings', universalTokenVerifier, getProfileSettings);
router.put('/settings', universalTokenVerifier, updateProfileSettings);

// Creator's own content management
router.get('/content', universalTokenVerifier, getMyContent);
router.put('/content/:id', universalTokenVerifier, updateContent);
router.delete('/content/:id', universalTokenVerifier, deleteContent);

// Content analytics
router.get('/content/:id/analytics', universalTokenVerifier, getContentAnalytics);

// Comment deletion (user can only delete own comments)
router.delete('/comments/:commentId', universalTokenVerifier, deleteComment);

export default router;
