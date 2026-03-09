import express from 'express';
import { optionalTokenVerifier } from '../../controllers/auth-controllers/universalTokenVerifier.js';
import {
    startSession,
    sessionHeartbeat,
    endSession,
    trackPageUsage,
    trackContentWatchtime,
    batchTrack,
} from '../../controllers/analytics-controllers/analyticsTrackingController.js';

const analyticsRouter = express.Router();

// All analytics tracking endpoints use optional auth —
// works for both logged-in users and anonymous visitors
analyticsRouter.use(optionalTokenVerifier);

// Session management
analyticsRouter.post('/session/start', startSession);
analyticsRouter.post('/session/heartbeat', sessionHeartbeat);
analyticsRouter.post('/session/end', endSession);

// Page usage tracking
analyticsRouter.post('/page-usage', trackPageUsage);

// Content watchtime tracking
analyticsRouter.post('/content-watchtime', trackContentWatchtime);

// Batch tracking (combines multiple events in one request)
analyticsRouter.post('/batch', batchTrack);

export default analyticsRouter;
