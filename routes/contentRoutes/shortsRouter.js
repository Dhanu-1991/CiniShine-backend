/**
 * Shorts Router - /api/v2/content/short & /api/v2/content/shorts
 */

import express from 'express';
import { shortUploadInit, shortUploadComplete, getShortsPlayerFeed } from '../../controllers/content-controllers/shortsController.js';
import { universalTokenVerifier, optionalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Upload
router.post('/init', universalTokenVerifier, shortUploadInit);
router.post('/complete', universalTokenVerifier, shortUploadComplete);

// Player feed (public)
router.get('/feed', optionalTokenVerifier, getShortsPlayerFeed);

export default router;
