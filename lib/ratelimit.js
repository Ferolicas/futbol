/**
 * Rate limiters compartidos para el middleware Next.js.
 *
 * Usan @upstash/ratelimit con la REST API de Upstash Redis → funcionan
 * en Edge runtime (donde corre middleware.js) sin TCP sockets.
 *
 * Lista de buckets (key prefix por bucket evita colisiones entre
 * limiters cuando varios chequean al mismo identifier):
 *
 *   auth      10/min/IP   — /api/auth/*
 *   checkout   5/min/IP   — /api/checkout
 *   register   5/min/IP   — /api/register
 *   admin    120/min/user — /api/admin/*, /ferney/* (autenticado)
 *                            120/min porque el panel /ferney hace polling
 *                            cada 2s = 30 req/min solo de lectura. Con 30
 *                            saturaba antes de cualquier click. 120 deja
 *                            margen real para acciones manuales (~90/min
 *                            disponibles tras descontar el polling).
 *   apiGen    60/min/IP   — resto de /api/*
 *
 * Sin UPSTASH_REDIS_REST_URL/TOKEN → los limiters se exportan como null
 * y el middleware hace bypass (no bloquea trafico legitimo en dev/sin
 * red). En produccion siempre estaran seteados.
 */
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = (url && token) ? new Redis({ url, token }) : null;

function build(prefix, limit, windowSec) {
  if (!redis) return null;
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
    prefix: `rl:${prefix}`,
    // analytics: false  // si lo activamos consume mas writes; default off.
  });
}

export const rateLimiters = {
  auth:     build('auth',     10, 60),
  checkout: build('checkout',  5, 60),
  register: build('register',  5, 60),
  admin:    build('admin',   120, 60),
  apiGen:   build('apiGen',   60, 60),
};

export const RATE_LIMIT_MESSAGE = 'Demasiadas solicitudes, intenta de nuevo en un momento';
