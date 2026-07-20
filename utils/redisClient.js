/**
 * Redis Client — Shared Redis connection for the application.
 *
 * Used for:
 * - Resume position storage (low-latency reads/writes)
 * - Future: rate limiting, caching, session storage
 *
 * Connection is lazy — connects on first use.
 * Falls back gracefully if Redis is unavailable.
 */
import Redis from 'ioredis';

let redis = null;
let connectionFailed = false;

/**
 * Get or create the Redis client singleton.
 * Returns null if Redis is not configured or connection failed.
 */
export function getRedisClient() {
    if (connectionFailed) return null;
    if (redis) return redis;

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        console.warn('⚠️  REDIS_URL not set — resume position will use MongoDB fallback');
        connectionFailed = true;
        return null;
    }

    try {
        redis = new Redis(redisUrl, {
            maxRetriesPerRequest: 3,
            retryStrategy(times) {
                if (times > 5) {
                    console.error('❌ Redis: max retries reached, giving up');
                    connectionFailed = true;
                    return null; // Stop retrying
                }
                return Math.min(times * 200, 2000);
            },
            connectTimeout: 5000,
            lazyConnect: true,
        });

        redis.on('connect', () => console.log('✅ Redis connected'));
        redis.on('error', (err) => {
            if (!connectionFailed) {
                console.error('❌ Redis error:', err.message);
            }
        });
        redis.on('close', () => {
            console.warn('⚠️  Redis connection closed');
        });

        // Initiate connection
        redis.connect().catch((err) => {
            console.error('❌ Redis connection failed:', err.message);
            connectionFailed = true;
            redis = null;
        });

        return redis;
    } catch (err) {
        console.error('❌ Redis init error:', err.message);
        connectionFailed = true;
        return null;
    }
}

/**
 * Gracefully close Redis connection (for process shutdown).
 */
export async function closeRedis() {
    if (redis) {
        try {
            await redis.quit();
        } catch {
            // ignore
        }
        redis = null;
    }
}
