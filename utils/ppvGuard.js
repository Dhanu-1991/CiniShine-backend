/**
 * PPV Access Guard Utility
 *
 * Shared helper for checking Pay Per View access.
 * Used by both route-level middleware (payPerViewAccess.js) and
 * controller-level checks for defense-in-depth.
 *
 * This file is the SINGLE source of truth for the PPV access check.
 * Do not duplicate this logic elsewhere.
 */

import Purchase from '../models/purchase.model.js';
import Admin from '../models/admin.model.js';
import User from '../models/user.model.js';

/**
 * Check if a userId belongs to an Admin or SuperAdmin
 */
export async function isAdminUser(userId) {
    if (!userId) return false;
    try {
        const adminDoc = await Admin.findById(userId).lean();
        if (adminDoc && (adminDoc.role === 'admin' || adminDoc.role === 'superadmin')) {
            return true;
        }
        const userDoc = await User.findById(userId).select('role roles isAdmin').lean();
        if (userDoc && (userDoc.role === 'admin' || userDoc.role === 'superadmin' || userDoc.isAdmin || userDoc.roles?.includes('Admin'))) {
            return true;
        }
    } catch (e) {
        /* silent catch */
    }
    return false;
}

/**
 * Check whether a user has active PPV access for a given content document.
 *
 * Returns `true` (access granted) if any of the following hold:
 *   1. Content is not pay_per_view (public, unlisted, private, etc.)
 *   2. The requesting user is an Admin or SuperAdmin
 *   3. The requesting user is the content creator
 *   4. The user has an active, non-expired Purchase record for this content
 *
 * Returns `false` (access denied) otherwise.
 *
 * @param {Object} content  - Mongoose document or lean object with _id, visibility, userId, price
 * @param {string|null} userId - The requesting user's ID string, or null/undefined for anonymous
 * @returns {Promise<boolean>}
 */
export async function hasPpvAccess(content, userId) {
    // Not PPV → always allowed
    if (!content || content.visibility !== 'pay_per_view') {
        return true;
    }

    // Anonymous users can never access PPV content
    if (!userId) {
        return false;
    }

    // Admin / SuperAdmin bypass — full access to all PPV content
    if (await isAdminUser(userId)) {
        return true;
    }

    // Creator always has access to their own content
    const creatorId = content.userId?._id?.toString() || content.userId?.toString();
    if (creatorId && creatorId === userId) {
        return true;
    }

    // Check for an active, non-expired purchase
    const purchase = await Purchase.findOne({
        contentId: content._id,
        buyerId: userId,
        status: 'active',
        expiresAt: { $gt: new Date() },
    }).lean();

    return !!purchase;
}

/**
 * Strip media source fields from a content object, replacing them with nulls.
 * Returns a new object (does not mutate the input).
 * Used by feed/search/listing controllers to sanitize PPV items in bulk responses.
 *
 * @param {Object} item - Content item (plain object)
 * @returns {Object} - Same item with media fields nulled and ppvRequired flag set
 */
export function stripMediaFields(item) {
    return {
        ...item,
        // Video fields
        hlsMasterUrl: null,
        hlsMasterKey: undefined,
        videoUrl: null,
        // Audio fields
        audioUrl: null,
        // Raw keys that could be used to construct CDN URLs
        hlsKey: undefined,
        processedKey: undefined,
        originalKey: undefined,
        // PPV gate flags
        ppvRequired: true,
        price: item.price || null,
    };
}

/**
 * Batch-check PPV access for an array of content items.
 * Returns a Set of content ID strings that the user has access to.
 * Used by feed controllers to efficiently check multiple items in one query.
 *
 * @param {Array<Object>} items - Array of content items
 * @param {string|null} userId - Requesting user's ID
 * @returns {Promise<Set<string>>} - Set of content IDs the user has purchased
 */
export async function batchCheckPpvAccess(items, userId) {
    const ppvItems = items.filter(item => item.visibility === 'pay_per_view');
    if (ppvItems.length === 0) return new Set();

    // If no user, no access to any PPV item
    if (!userId) return new Set();

    // Admin / SuperAdmin bypass — full access to all PPV items
    if (await isAdminUser(userId)) {
        return new Set(ppvItems.map(item => item._id.toString()));
    }

    // Creator always has access to their own content
    const accessSet = new Set();
    const needsPurchaseCheck = [];

    for (const item of ppvItems) {
        const creatorId = item.userId?._id?.toString() || item.userId?.toString();
        if (creatorId === userId) {
            accessSet.add(item._id.toString());
        } else {
            needsPurchaseCheck.push(item._id);
        }
    }

    if (needsPurchaseCheck.length > 0) {
        const purchases = await Purchase.find({
            contentId: { $in: needsPurchaseCheck },
            buyerId: userId,
            status: 'active',
            expiresAt: { $gt: new Date() },
        }).select('contentId').lean();

        for (const p of purchases) {
            accessSet.add(p.contentId.toString());
        }
    }

    return accessSet;
}
