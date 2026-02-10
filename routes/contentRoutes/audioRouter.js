/**
 * Audio Router - /api/v2/content/audio
 */

import express from 'express';
import { audioUploadInit, audioUploadComplete, getAudioPlayerFeed } from '../../controllers/content-controllers/audioController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Upload
router.post('/init', universalTokenVerifier, audioUploadInit);
router.post('/complete', universalTokenVerifier, audioUploadComplete);

// Player feed
router.get('/feed', universalTokenVerifier, getAudioPlayerFeed);

export default router;
