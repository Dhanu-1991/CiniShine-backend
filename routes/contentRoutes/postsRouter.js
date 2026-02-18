/**
 * Posts Router - /api/v2/content/posts
 */

import express from 'express';
import { postImageInit, createPost, getSubscriptionPosts } from '../../controllers/content-controllers/postsController.js';
import { universalTokenVerifier, optionalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Create post
router.post('/image/init', universalTokenVerifier, postImageInit);
router.post('/create', universalTokenVerifier, createPost);

// Feed (public - but shows personalised content if token present)
router.get('/feed', optionalTokenVerifier, getSubscriptionPosts);

export default router;
