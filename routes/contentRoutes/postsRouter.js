/**
 * Posts Router - /api/v2/content/posts
 */

import express from 'express';
import { postImageInit, createPost, getSubscriptionPosts } from '../../controllers/content-controllers/postsController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Create post
router.post('/image/init', universalTokenVerifier, postImageInit);
router.post('/create', universalTokenVerifier, createPost);

// Feed
router.get('/feed', universalTokenVerifier, getSubscriptionPosts);

export default router;
