/**
 * History Router - /api/v2/history
 * Watch history management routes (all require authentication)
 */

import express from 'express';
import {
    getWatchHistory,
    deleteHistoryItems,
    deleteAllHistory,
    toggleHistoryPause,
    getHistoryPauseStatus,
} from '../../controllers/history-controllers/historyController.js';
import { universalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';

const router = express.Router();

// Get paginated watch history
router.get('/', universalTokenVerifier, getWatchHistory);

// Delete selected history items
router.delete('/', universalTokenVerifier, deleteHistoryItems);

// Clear all history
router.delete('/all', universalTokenVerifier, deleteAllHistory);

// Toggle history pause
router.put('/pause', universalTokenVerifier, toggleHistoryPause);

// Get pause status
router.get('/pause-status', universalTokenVerifier, getHistoryPauseStatus);

export default router;
