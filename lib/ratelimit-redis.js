// A2 FIX (parcial, seguro): rate-limit COMPARTIDO entre procesos, respaldado por
// el Redis local. El middleware de Next corre en runtime Edge y NO puede usar
// ioredis (TCP) → su limiter sigue siendo in-memory (capa gruesa). Este helper
// es para los HANDLERS (runtime Node) de los endpoints sensibles a fuerza bruta /
// abuso (login, register, forgot/reset password), donde un límite compartido sí
// importa aunque haya varios procesos PM2.
//
// Algoritmo: ventana fija con INCR atómico. La primera escritura de la ventana
// fija el TTL. Cada caller decide si una caída de Redis falla abierta o cerrada.
import { redisIncr } from './redis.js';

export async function redisRateLimit(bucket, id, limit, windowSec, { failClosed = false } = {}) {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${bucket}:${id}:${win}`;
  const count = await redisIncr(key, windowSec); // INCR (+EXPIRE en el primero)
  if (count === null) {
    // Auth y generadores CPU-heavy eligen failClosed para que una caída de Redis
    // no quite precisamente la barrera anti fuerza-bruta/DoS.
    return { success: !failClosed, remaining: 0, reset: 0, available: false };
  }
  return {
    success: count <= limit,
    remaining: Math.max(0, limit - count),
    reset: (win + 1) * windowSec * 1000,
    available: true,
  };
}

// Caddy añade el peer real al final de X-Forwarded-For. Tomar el primer valor
// permitiría a un cliente anteponer una IP inventada y evadir el rate limit.
export function clientIp(request) {
  const xff = request.headers.get('x-forwarded-for');
  const candidate = xff?.split(',').at(-1)?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'anonymous';
  return candidate.replace(/[^0-9a-fA-F:.]/g, '').slice(0, 64) || 'anonymous';
}
