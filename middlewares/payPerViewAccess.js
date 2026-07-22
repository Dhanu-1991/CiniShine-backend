/**
 * Pay Per View Access Middleware
 *
 * Route-level middleware that blocks requests for PPV content when the
 * requester does not have a valid, non-expired purchase.
 *
 * This is the OUTER defense layer. Controllers add a second, inner check
 * using hasPpvAccess() from utils/ppvGuard.js for defense-in-depth.
 *
 * Param name handling: the actual routes use :id, :videoId, or :contentId
 * depending on the route file. This middleware checks all three.
 */

import Content from '../models/content.model.js';
import { hasPpvAccess } from '../utils/ppvGuard.js';

const payPerViewAccess = async (req, res, next) => {
    try {
        // Routes use different param names — check all of them
        const contentId = req.params.id || req.params.videoId || req.params.contentId || req.body.contentId;

        if (!contentId) {
            // No content ID in this request (e.g., feed listing) — let controller handle it
            return next();
        }

        const content = await Content.findById(contentId).select('visibility userId price trailerContentId spoilerContentId spoilerText');
        if (!content) {
            return res.status(404).json({ error: 'Content not found' });
        }

        // Not PPV → pass through
        if (content.visibility !== 'pay_per_view') {
            return next();
        }

        // Use the shared access check (creator check + purchase lookup)
        const userId = req.user?.id || null;
        const hasAccess = await hasPpvAccess(content, userId);

        if (!hasAccess) {
            return res.status(403).json({
                error: 'Purchase required',
                ppvRequired: true,
                price: content.price,
                contentId: content._id,
                trailerContentId: content.trailerContentId || content.spoilerContentId || null,
                spoilerContentId: content.spoilerContentId || content.trailerContentId || null,
                spoilerText: content.spoilerText || null,
            });
        }

        // Attach content to request so controllers don't need to re-fetch
        req.ppvContent = content;
        next();
    } catch (error) {
        console.error('Error in payPerViewAccess middleware:', error);
        res.status(500).json({ error: 'Server error checking content access' });
    }
};

export default payPerViewAccess;
