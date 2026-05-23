// ──────────────────────────────────────────────────────────────────────────
// Dual-mode Redis client.
//
// MODE DETECTION: env var `WORKER_LOCAL_REDIS`.
//   - 'true'  → LOCAL TCP (ioredis a 127.0.0.1:6379) + mirror write a Upstash.
//               Solo el worker en el VPS (apps/cfanalisis-worker) usa esto.
//   - else    → Upstash REST API exclusivamente. Vercel/Next.js usa esto.
//
// Why dual:
//   El worker corre en el VPS al lado del Redis local (1ms TCP, gratis,
//   sin limites). Antes usaba Upstash REST por error y reventaba la cuota
//   500k/dia con los crons cada minuto. Cuando matemos Vercel (Fase 4)
//   se quita el mirror y todo queda en local.
//
// Mirror write semantics:
//   Cuando WORKER_LOCAL_REDIS=true, SET/DEL escriben primero a local
//   (autoritativo) y disparan un fire-and-forget a Upstash para que Vercel
//   siga viendo datos frescos. Si Upstash esta capped (429), el worker
//   sigue funcionando — Upstash es best-effort, no bloqueante.
//
// Migration note:
//   En Fase 4 (DNS switch a VPS), quitar este archivo dual y dejar solo
//   ioredis. Tambien borrar @upstash/redis del package.json.
// ──────────────────────────────────────────────────────────────────────────

import { Redis as UpstashRedis } from '@upstash/redis';

const USE_LOCAL = process.env.WORKER_LOCAL_REDIS === 'true';

let _upstash = null;
let _local = null;
let _localImportPromise = null;

function getUpstash() {
  if (_upstash) return _upstash;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _upstash = new UpstashRedis({ url, token });
  return _upstash;
}

// Lazy-import ioredis solo cuando USE_LOCAL=true. En Vercel, ioredis nunca
// se importa (aunque este en node_modules), evitando connect intentos.
async function ensureLocal() {
  if (_local) return _local;
  if (!_localImportPromise) {
    _localImportPromise = (async () => {
      const { default: IORedis } = await import('ioredis');
      const client = new IORedis({
        host: process.env.LOCAL_REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.LOCAL_REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: 3,
        lazyConnect: false,
        enableReadyCheck: true,
      });
      client.on('error', (err) =>
        console.error('[REDIS-LOCAL] connection error:', err.message),
      );
      _local = client;
      return client;
    })();
  }
  return _localImportPromise;
}

export const KEYS = {
  fixtures: (date) => `fixtures:${date}`,
  liveStats: (date) => `live:${date}`,
  fixtureStats: (fid) => `stats:${fid}`,
  schedule: (date) => `schedule:${date}`,
  liveCronLock: 'cron:live:lock',
  userHidden: (userId) => `user:hidden:${userId}`,
};

export const TTL = {
  fixtures: 26 * 3600,       // 26 hours
  liveStats: 2 * 3600,       // 2 hours
  fixtureStats: 48 * 3600,   // 48 hours — survive until next day
  schedule: 26 * 3600,       // 26 hours
  yesterday: 48 * 3600,      // 48 hours
};

/**
 * GET. En WORKER_LOCAL_REDIS=true lee SOLO de local (no toca Upstash).
 * En default mode lee de Upstash.
 */
export async function redisGet(key) {
  if (USE_LOCAL) {
    try {
      const local = await ensureLocal();
      const val = await local.get(key);
      if (val == null) return null;
      // ioredis devuelve strings — intentamos parsear JSON, sino devolvemos raw
      try { return JSON.parse(val); } catch { return val; }
    } catch (e) {
      console.error('[REDIS-LOCAL] GET error:', key, e.message);
      return null;
    }
  }
  const r = getUpstash();
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
 * SET con TTL. En WORKER_LOCAL_REDIS=true escribe a local (autoritativo)
 * y dispara mirror a Upstash en background (para que Vercel lo vea).
 * Si Upstash esta capped, no bloquea ni rompe.
 */
export async function redisSet(key, value, ttlSeconds) {
  if (USE_LOCAL) {
    let ok = false;
    try {
      const local = await ensureLocal();
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      await local.set(key, serialized, 'EX', ttlSeconds);
      ok = true;
    } catch (e) {
      console.error('[REDIS-LOCAL] SET error:', key, e.message);
    }
    // Mirror a Upstash — fire-and-forget. Vercel sigue leyendo Upstash hasta Fase 4.
    const r = getUpstash();
    if (r) {
      r.set(key, value, { ex: ttlSeconds }).catch((e) => {
        const msg = String(e?.message || '');
        // Silenciamos errores de cuota — son esperados cuando Upstash esta capped.
        // No rompemos el worker por esto.
        if (!msg.includes('max requests limit') && !msg.includes('429')) {
          console.error('[REDIS] mirror SET error:', key, msg);
        }
      });
    }
    return ok;
  }
  const r = getUpstash();
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
 * Atomic INCR. Solo afecta local en modo worker — los contadores (ej API
 * call counts) son por-proceso y Vercel no los comparte con el worker.
 */
export async function redisIncr(key, ttlSeconds) {
  if (USE_LOCAL) {
    try {
      const local = await ensureLocal();
      const count = await local.incr(key);
      if (count === 1 && ttlSeconds) await local.expire(key, ttlSeconds);
      return count;
    } catch (e) {
      console.error('[REDIS-LOCAL] INCR error:', key, e.message);
      return null;
    }
  }
  const r = getUpstash();
  if (!r) return null;
  try {
    const count = await r.incr(key);
    if (count === 1 && ttlSeconds) await r.expire(key, ttlSeconds);
    return count;
  } catch (e) {
    console.error('[REDIS] INCR error:', key, e.message);
    return null;
  }
}

/**
 * DEL. En modo worker borra de local + Upstash (best-effort).
 */
export async function redisDel(key) {
  if (USE_LOCAL) {
    try {
      const local = await ensureLocal();
      await local.del(key);
    } catch (e) {
      console.error('[REDIS-LOCAL] DEL error:', key, e.message);
    }
    const r = getUpstash();
    if (r) {
      r.del(key).catch(() => {});  // best-effort
    }
    return true;
  }
  const r = getUpstash();
  if (!r) return false;
  try {
    await r.del(key);
    return true;
  } catch (e) {
    console.error('[REDIS] DEL error:', key, e.message);
    return false;
  }
}
