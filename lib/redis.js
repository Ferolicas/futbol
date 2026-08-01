// ──────────────────────────────────────────────────────────────────────────
// Redis client — local TCP only (post-Fase 4: Upstash eliminado).
//
// Tras matar Vercel + Upstash (DNS switch 2026-05-23), TODO el stack corre
// en el mismo VPS donde vive Redis local. No hay razon para mantener un
// cliente REST externo. ioredis conecta directamente a 127.0.0.1:6379.
//
// WORKER_LOCAL_REDIS env var ya NO se necesita — se mantiene por
// compatibilidad pero todos los caminos usan local ahora.
// ──────────────────────────────────────────────────────────────────────────

import IORedis from 'ioredis';

let _client = null;

function getClient() {
  if (_client) return _client;
  // W5 FIX: leer también REDIS_HOST/PORT/PASSWORD (los que usa el worker) para que
  // web y worker no diverjan. Antes la web solo leía LOCAL_REDIS_* y NO la password
  // → si el Redis tuviera password, la web no conectaba (en silencio).
  _client = new IORedis({
    host: process.env.LOCAL_REDIS_HOST || process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.LOCAL_REDIS_PORT || process.env.REDIS_PORT || '6379', 10),
    password: process.env.LOCAL_REDIS_PASSWORD || process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    enableReadyCheck: true,
  });
  _client.on('error', (err) =>
    console.error('[REDIS] connection error:', err.message),
  );
  return _client;
}

// Solo para procesos CLI de una sola ejecución. La web y el worker conservan
// su conexión durante toda la vida del proceso y no deben llamar esta función.
export async function closeRedisClient() {
  if (!_client) return;
  const client = _client;
  _client = null;
  try { await client.quit(); }
  catch { client.disconnect(); }
}

export const KEYS = {
  fixtures:     (date)   => `fixtures:${date}`,
  liveStats:    (date)   => `live:${date}`,
  fixtureStats: (fid)    => `stats:${fid}`,
  schedule:     (date)   => `schedule:${date}`,
  liveCronLock: 'cron:live:lock',
  userHidden:   (userId) => `user:hidden:${userId}`,
};

export const TTL = {
  fixtures:     26 * 3600,
  liveStats:     2 * 3600,
  fixtureStats: 48 * 3600,
  schedule:     26 * 3600,
  yesterday:    48 * 3600,
};

/** GET key. Devuelve null si no existe o si Redis falla. */
export async function redisGet(key) {
  try {
    const client = getClient();
    const val = await client.get(key);
    if (val == null) return null;
    // ioredis devuelve strings — intentamos parsear JSON, sino crudo
    try { return JSON.parse(val); } catch { return val; }
  } catch (e) {
    console.error('[REDIS] GET error:', key, e.message);
    return null;
  }
}

/** MGET en un solo round-trip. Mantiene el orden de `keys`. */
export async function redisMGet(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  try {
    const client = getClient();
    const values = await client.mget(...keys);
    return values.map((value) => {
      if (value == null) return null;
      try { return JSON.parse(value); } catch { return value; }
    });
  } catch (e) {
    console.error('[REDIS] MGET error:', e.message);
    return keys.map(() => null);
  }
}

/** SET key con TTL en segundos. Devuelve true si exito. */
export async function redisSet(key, value, ttlSeconds) {
  try {
    const client = getClient();
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await client.set(key, serialized, 'EX', ttlSeconds);
    return true;
  } catch (e) {
    console.error('[REDIS] SET error:', key, e.message);
    return false;
  }
}

/** Atomic INCR. Set TTL on first increment. */
export async function redisIncr(key, ttlSeconds) {
  try {
    const client = getClient();
    const count = await client.incr(key);
    if (count === 1 && ttlSeconds) await client.expire(key, ttlSeconds);
    return count;
  } catch (e) {
    console.error('[REDIS] INCR error:', key, e.message);
    return null;
  }
}

/** Atomic INCRBY n. Set TTL on first increment. */
export async function redisIncrBy(key, n, ttlSeconds) {
  try {
    const client = getClient();
    const count = await client.incrby(key, n);
    if (count === n && ttlSeconds) await client.expire(key, ttlSeconds);
    return count;
  } catch (e) {
    console.error('[REDIS] INCRBY error:', key, e.message);
    return null;
  }
}

/**
 * Reserva atómicamente un turno distribuido para un proveedor externo.
 * Devuelve 0 cuando el turno fue adquirido, los milisegundos que faltan si
 * otro proceso lo ocupa, o null si Redis no está disponible.
 */
export async function redisAcquireRateSlot(key, intervalMs) {
  try {
    const client = getClient();
    const ttl = Math.max(1, Math.ceil(Number(intervalMs) || 1));
    const result = await client.eval(
      `local remaining = redis.call('PTTL', KEYS[1])
       if remaining > 0 then return remaining end
       redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[1])
       return 0`,
      1,
      key,
      ttl,
      String(Date.now()),
    );
    return Number(result);
  } catch (e) {
    console.error('[REDIS] rate slot error:', key, e.message);
    return null;
  }
}

/**
 * EL1: push atómico a una LISTA Redis (LPUSH + LTRIM + EXPIRE en pipeline).
 * Newest-first. Reemplaza el read-modify-write (get array → push → set) que
 * perdía entradas bajo concurrencia. Auto-cura si la key tenía otro tipo
 * (string legacy) → DEL y reintenta una vez.
 */
export async function redisListPush(key, value, maxLen, ttlSeconds) {
  const client = getClient();
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const run = async () => {
    const pipe = client.pipeline();
    pipe.lpush(key, serialized);
    if (maxLen) pipe.ltrim(key, 0, maxLen - 1);
    if (ttlSeconds) pipe.expire(key, ttlSeconds);
    await pipe.exec();
  };
  try {
    await run();
    return true;
  } catch (e) {
    if (/WRONGTYPE/i.test(e.message || '')) {
      try { await client.del(key); await run(); return true; } catch {}
    }
    console.error('[REDIS] LPUSH error:', key, e.message);
    return false;
  }
}

/** LRANGE → array de elementos parseados (JSON si aplica). */
export async function redisListRange(key, start = 0, stop = -1) {
  try {
    const client = getClient();
    const items = await client.lrange(key, start, stop);
    return items.map((s) => { try { return JSON.parse(s); } catch { return s; } });
  } catch (e) {
    console.error('[REDIS] LRANGE error:', key, e.message);
    return [];
  }
}

/** DEL key. */
export async function redisDel(key) {
  try {
    const client = getClient();
    await client.del(key);
    return true;
  } catch (e) {
    console.error('[REDIS] DEL error:', key, e.message);
    return false;
  }
}
