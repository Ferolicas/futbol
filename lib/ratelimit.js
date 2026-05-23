/**
 * Rate limiters in-memory para el middleware Next.js.
 *
 * Tras Fase 4 (Upstash eliminado, todo en VPS):
 *   - Stack es un solo proceso Node en PM2 → un Map en memoria del proceso
 *     es suficiente. No hay multi-instancia donde compartir estado.
 *   - Si en el futuro escalas a multi-instancia (cluster, Docker swarm),
 *     migrar a Redis local TCP via ioredis con Lua scripts atomicos.
 *
 * Algoritmo: sliding window simple. Por cada identifier (IP o userId)
 * guardamos timestamps de los hits recientes. Al evaluar, contamos
 * cuantos timestamps caen en la ventana [now - windowMs, now]. Si
 * <= limit → success. Sino → block + devolver reset = oldest + windowMs.
 *
 * Cleanup: cada N hits hacemos una pasada de garbage collection sobre
 * timestamps fuera de ventana. Sin GC el Map crece sin límite.
 *
 * Lista de buckets:
 *   auth      10/min/IP   — /api/auth/*
 *   checkout   5/min/IP   — /api/checkout
 *   register   5/min/IP   — /api/register
 *   admin    120/min/user — /api/admin/*, /ferney/* (autenticado)
 *   apiGen    60/min/IP   — resto de /api/*
 */

const stores = new Map();   // bucketName → Map<identifier, number[]>
const cleanupCounters = new Map();   // bucketName → int (hits since last GC)
const CLEANUP_EVERY = 200;

function getStore(bucket) {
  let s = stores.get(bucket);
  if (!s) { s = new Map(); stores.set(bucket, s); }
  return s;
}

function gc(bucket, windowMs) {
  const counter = (cleanupCounters.get(bucket) || 0) + 1;
  if (counter < CLEANUP_EVERY) {
    cleanupCounters.set(bucket, counter);
    return;
  }
  cleanupCounters.set(bucket, 0);
  const store = getStore(bucket);
  const now = Date.now();
  const cutoff = now - windowMs;
  for (const [id, hits] of store.entries()) {
    const fresh = hits.filter((t) => t > cutoff);
    if (fresh.length === 0) store.delete(id);
    else store.set(id, fresh);
  }
}

function buildLimiter(bucket, limit, windowSec) {
  const windowMs = windowSec * 1000;
  return {
    async limit(identifier) {
      const store = getStore(bucket);
      const now = Date.now();
      const cutoff = now - windowMs;
      const hits = (store.get(identifier) || []).filter((t) => t > cutoff);
      gc(bucket, windowMs);

      if (hits.length >= limit) {
        // Bloqueado. El reset es cuando el hit mas antiguo cae fuera de la ventana.
        const oldest = hits[0];
        return {
          success: false,
          limit,
          remaining: 0,
          reset: oldest + windowMs,
        };
      }

      hits.push(now);
      store.set(identifier, hits);
      return {
        success: true,
        limit,
        remaining: limit - hits.length,
        reset: now + windowMs,
      };
    },
  };
}

export const rateLimiters = {
  auth:     buildLimiter('auth',     10, 60),
  checkout: buildLimiter('checkout',  5, 60),
  register: buildLimiter('register',  5, 60),
  admin:    buildLimiter('admin',   120, 60),
  apiGen:   buildLimiter('apiGen',   60, 60),
};

export const RATE_LIMIT_MESSAGE = 'Demasiadas solicitudes, intenta de nuevo en un momento';
