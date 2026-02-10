/**
 * Channel Router - /api/v2/channel
 * Public channel page routes
 */

import express from 'express';
import { getChannelPage, getChannelContent } from '../../controllers/channel-controllers/channelController.js';
import { optionalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Get channel page data (public, but optional auth for subscription status)
router.get('/:channelName', optionalTokenVerifier, getChannelPage);

// Get channel content by type with sorting
router.get('/:channelName/content', optionalTokenVerifier, getChannelContent);

export default router;
