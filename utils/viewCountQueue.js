import Content from '../models/content.model.js';

/**
 * ViewCountQueue — In-memory batched view counter.
 *
 * Instead of writing `content.views++` on every view event, we accumulate
 * increments in a Map and flush them to the database periodically using
 * bulkWrite with $inc.  This dramatically reduces write amplification
 * under high traffic.
 *
 * Usage:
 *   import { incrementView, flushViewCounts } from './viewCountQueue.js';
 *   incrementView(contentId);                        // non-blocking
 *   await flushViewCounts();                         // called by interval
 */

const pendingViews = new Map();  // contentId (string) → pending count

const FLUSH_INTERVAL_MS = 10_000;     // 10 seconds
const MAX_BATCH_SIZE     = 100;       // flush early if queue exceeds this

let flushTimer = null;

/**
 * Queue a +1 view for the given content ID.
 * Does NOT write to the database immediately.
 */
export function incrementView(contentId) {
    if (!contentId) return;
    const key = contentId.toString();
    pendingViews.set(key, (pendingViews.get(key) || 0) + 1);

    // Flush early if the queue is very large (burst traffic)
    if (pendingViews.size >= MAX_BATCH_SIZE && !flushTimer?._flushInProgress) {
        flushViewCounts().catch(() => {});
    }
}

/**
 * Flush all pending view increments to the database.
 * Uses Content.bulkWrite with $inc for atomic, efficient updates.
 */
export async function flushViewCounts() {
    if (pendingViews.size === 0) return;

    // Take a snapshot and clear the map
    const snapshot = new Map(pendingViews);
    pendingViews.clear();

    const ops = [];
    for (const [contentId, count] of snapshot) {
        ops.push({
            updateOne: {
                filter: { _id: contentId },
                update: { $inc: { views: count } },
            },
        });
    }

    if (ops.length === 0) return;

    try {
        await Content.bulkWrite(ops, { ordered: false });
    } catch (error) {
        console.error('❌ [ViewCountQueue] bulkWrite failed, re-queuing:', error.message);
        // Re-queue failed increments so they aren't lost
        for (const [contentId, count] of snapshot) {
            pendingViews.set(contentId, (pendingViews.get(contentId) || 0) + count);
        }
    }
}

/**
 * Start the periodic flush interval.
 * Called once at server startup.
 */
export function startViewCountFlusher() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
        flushViewCounts().catch((err) =>
            console.error('❌ [ViewCountQueue] flush error:', err.message)
        );
    }, FLUSH_INTERVAL_MS);

    // Don't prevent Node process from exiting
    if (flushTimer.unref) flushTimer.unref();
    console.log(`✅ [ViewCountQueue] Flusher started (every ${FLUSH_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the flusher and do a final flush (for graceful shutdown).
 */
export async function stopViewCountFlusher() {
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
    await flushViewCounts();
}

/**
 * Get current queue size (for monitoring/debugging).
 */
export function getQueueSize() {
    return pendingViews.size;
}
