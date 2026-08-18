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
    getRecommendedProfiles,
    getContentAnalytics,
    checkContentActiveRentals,
    permanentlyDeleteContent,
} from '../../controllers/profile-controllers/profileController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Profile settings
router.get('/settings', universalTokenVerifier, getProfileSettings);
router.put('/settings', universalTokenVerifier, updateProfileSettings);
router.get('/recommended-profiles', universalTokenVerifier, getRecommendedProfiles);

// Creator's own content management
router.get('/content', universalTokenVerifier, getMyContent);
router.put('/content/:id', universalTokenVerifier, updateContent);
router.delete('/content/:id', universalTokenVerifier, deleteContent);

// Content analytics
router.get('/content/:id/analytics', universalTokenVerifier, getContentAnalytics);

// Content rental check & permanent deletion
router.get('/content/:id/active-rentals', universalTokenVerifier, checkContentActiveRentals);
router.delete('/content/:id/permanent', universalTokenVerifier, permanentlyDeleteContent);

// Comment deletion (user can only delete own comments)
router.delete('/comments/:commentId', universalTokenVerifier, deleteComment);

export default router;
