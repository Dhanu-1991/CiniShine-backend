/**
 * Resume Position Controller
 *
 * Redis-backed, cross-device resume playback position tracking.
 *
 * DESIGN:
 * - Positions are stored in Redis for low-latency reads (key: resume:{userId}:{contentId})
 * - On save, also updates ContentView.lastPlayheadSeconds/bestPlayheadSeconds in MongoDB
 *   (debounced — only writes to Mongo if position changed by ≥5s or is a final save)
 * - On load, reads from Redis first; falls back to ContentView if Redis is down
 * - TTL: 90 days in Redis (auto-cleanup of stale entries)
 * - Anonymous users: not supported (resume requires auth for cross-device)
 */
import { getRedisClient } from '../../utils/redisClient.js';
import ContentView from '../../models/contentView.model.js';

const REDIS_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const REDIS_KEY_PREFIX = 'resume';
const MIN_POSITION_DELTA = 5; // Only write to Mongo if position changed by ≥5s

function redisKey(userId, contentId) {
    return `${REDIS_KEY_PREFIX}:${userId}:${contentId}`;
}

/**
 * GET /api/v2/resume/:contentId — Get resume position for authenticated user
 */
export const getResumePosition = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { contentId } = req.params;
        if (!contentId) return res.status(400).json({ error: 'contentId required' });

        let position = null;

        // Try Redis first (fast path)
        const redis = getRedisClient();
        if (redis) {
            try {
                const cached = await redis.get(redisKey(userId, contentId));
                if (cached !== null) {
                    position = JSON.parse(cached);
                }
            } catch (err) {
                console.warn('Redis get failed for resume position:', err.message);
            }
        }

        // Fallback to MongoDB
        if (position === null) {
            const view = await ContentView.findOne(
                { contentId, userId },
                { lastPlayheadSeconds: 1, bestPlayheadSeconds: 1 }
            ).lean();

            if (view && view.lastPlayheadSeconds > 0) {
                position = {
                    playheadSeconds: view.lastPlayheadSeconds,
                    bestPlayheadSeconds: view.bestPlayheadSeconds || 0,
                    updatedAt: view.lastWatchEventAt || null,
                };

                // Backfill Redis for next request
                if (redis) {
                    try {
                        await redis.setex(
                            redisKey(userId, contentId),
                            REDIS_TTL_SECONDS,
                            JSON.stringify(position)
                        );
                    } catch {
                        // ignore backfill failures
                    }
                }
            }
        }

        res.json({
            hasPosition: position !== null && position.playheadSeconds > 0,
            position: position || { playheadSeconds: 0, bestPlayheadSeconds: 0 },
        });
    } catch (error) {
        console.error('❌ Error getting resume position:', error);
        res.status(500).json({ error: 'Failed to get resume position' });
    }
};

/**
 * POST /api/v2/resume/:contentId — Save resume position
 *
 * Body: { playheadSeconds: number, duration?: number, isFinal?: boolean }
 *
 * isFinal=true means user paused, navigated away, or tab closed.
 * In that case, always persist to MongoDB immediately.
 */
export const saveResumePosition = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { contentId } = req.params;
        if (!contentId) return res.status(400).json({ error: 'contentId required' });

        const { playheadSeconds, duration, isFinal } = req.body;
        const position = Math.max(0, Number(playheadSeconds) || 0);

        // If position is near the end (>95%), reset to 0 (content completed)
        const effectivePosition = (duration && position > 0 && position / duration > 0.95) ? 0 : position;

        const now = new Date();
        const positionData = {
            playheadSeconds: effectivePosition,
            bestPlayheadSeconds: position, // Always track the max
            updatedAt: now.toISOString(),
        };

        // Write to Redis (fast, non-blocking)
        const redis = getRedisClient();
        if (redis) {
            try {
                // Read existing to preserve bestPlayheadSeconds
                const existing = await redis.get(redisKey(userId, contentId));
                if (existing) {
                    const prev = JSON.parse(existing);
                    positionData.bestPlayheadSeconds = Math.max(
                        prev.bestPlayheadSeconds || 0,
                        position
                    );
                }
                await redis.setex(
                    redisKey(userId, contentId),
                    REDIS_TTL_SECONDS,
                    JSON.stringify(positionData)
                );
            } catch (err) {
                console.warn('Redis set failed for resume position:', err.message);
            }
        }

        // Write to MongoDB (debounced — only if significant change or final save)
        let shouldWriteMongo = !!isFinal;
        if (!shouldWriteMongo) {
            // Check if position changed enough to warrant a Mongo write
            const view = await ContentView.findOne(
                { contentId, userId },
                { lastPlayheadSeconds: 1 }
            ).lean();
            const lastSaved = view?.lastPlayheadSeconds || 0;
            shouldWriteMongo = Math.abs(effectivePosition - lastSaved) >= MIN_POSITION_DELTA;
        }

        if (shouldWriteMongo) {
            await ContentView.findOneAndUpdate(
                { contentId, userId },
                {
                    $set: { lastPlayheadSeconds: effectivePosition, lastWatchEventAt: now },
                    $max: { bestPlayheadSeconds: position },
                },
                { upsert: false } // Don't create — ContentView is created by the analytics pipeline
            );
        }

        res.json({ success: true, position: effectivePosition });
    } catch (error) {
        console.error('❌ Error saving resume position:', error);
        res.status(500).json({ error: 'Failed to save resume position' });
    }
};

/**
 * GET /api/v2/resume/batch — Get resume positions for multiple content IDs
 * Query: ?ids=id1,id2,id3 (max 50)
 */
export const getBatchResumePositions = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const ids = (req.query.ids || '').split(',').filter(Boolean).slice(0, 50);
        if (ids.length === 0) return res.json({ positions: {} });

        const positions = {};

        // Try Redis batch read
        const redis = getRedisClient();
        const missingIds = [];

        if (redis) {
            try {
                const keys = ids.map(id => redisKey(userId, id));
                const values = await redis.mget(...keys);
                values.forEach((val, i) => {
                    if (val) {
                        positions[ids[i]] = JSON.parse(val);
                    } else {
                        missingIds.push(ids[i]);
                    }
                });
            } catch {
                missingIds.push(...ids);
            }
        } else {
            missingIds.push(...ids);
        }

        // Fallback to MongoDB for missing
        if (missingIds.length > 0) {
            const views = await ContentView.find(
                { contentId: { $in: missingIds }, userId, lastPlayheadSeconds: { $gt: 0 } },
                { contentId: 1, lastPlayheadSeconds: 1, bestPlayheadSeconds: 1 }
            ).lean();

            for (const view of views) {
                positions[view.contentId.toString()] = {
                    playheadSeconds: view.lastPlayheadSeconds,
                    bestPlayheadSeconds: view.bestPlayheadSeconds || 0,
                };
            }
        }

        res.json({ positions });
    } catch (error) {
        console.error('❌ Error getting batch resume positions:', error);
        res.status(500).json({ error: 'Failed to get resume positions' });
    }
};
