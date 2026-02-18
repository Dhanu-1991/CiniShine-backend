/**
 * Audio Router - /api/v2/content/audio
 */

import express from 'express';
import { audioUploadInit, audioUploadComplete, getAudioPlayerFeed } from '../../controllers/content-controllers/audioController.js';
import { universalTokenVerifier, optionalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Upload
router.post('/init', universalTokenVerifier, audioUploadInit);
router.post('/complete', universalTokenVerifier, audioUploadComplete);

// Player feed (public)
router.get('/feed', optionalTokenVerifier, getAudioPlayerFeed);

export default router;
