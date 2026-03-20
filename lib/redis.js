import { Redis } from '@upstash/redis';

// Lazy singleton — only created when first used
let _redis = null;

function getRedis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

export const KEYS = {
  fixtures: (date) => `fixtures:${date}`,
  liveStats: (date) => `live:${date}`,
  fixtureStats: (fid) => `stats:${fid}`,
  schedule: (date) => `schedule:${date}`,
};

// TTLs in seconds
export const TTL = {
  fixtures: 26 * 3600,      // 26 hours
  liveStats: 2 * 3600,      // 2 hours
  fixtureStats: 3 * 3600,   // 3 hours
  schedule: 26 * 3600,      // 26 hours
  yesterday: 48 * 3600,     // 48 hours
};

/**
 * Get value from Redis. Returns null if Redis is not configured or key doesn't exist.
 */
export async function redisGet(key) {
  const r = getRedis();
  if (!r) return null;
  try {
    const val = await r.get(key);
    return val ?? null;
  } catch (e) {
    console.error('[REDIS] GET error:', key, e.message);
    return null;
  }
}

/**
 * Set value in Redis with TTL (seconds). Silent fail if Redis is not configured.
 */
export async function redisSet(key, value, ttlSeconds) {
  const r = getRedis();
  if (!r) return false;
  try {
    await r.set(key, value, { ex: ttlSeconds });
    return true;
  } catch (e) {
    console.error('[REDIS] SET error:', key, e.message);
    return false;
  }
}

/**
 * Delete a key from Redis.
 */
export async function redisDel(key) {
  const r = getRedis();
  if (!r) return false;
  try {
    await r.del(key);
    return true;
  } catch (e) {
    console.error('[REDIS] DEL error:', key, e.message);
    return false;
  }
}
