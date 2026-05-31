// A2 FIX (parcial, seguro): rate-limit COMPARTIDO entre procesos, respaldado por
// el Redis local. El middleware de Next corre en runtime Edge y NO puede usar
// ioredis (TCP) → su limiter sigue siendo in-memory (capa gruesa). Este helper
// es para los HANDLERS (runtime Node) de los endpoints sensibles a fuerza bruta /
// abuso (login, register, forgot/reset password), donde un límite compartido sí
// importa aunque haya varios procesos PM2.
//
// Algoritmo: ventana fija con INCR atómico. La primera escritura de la ventana
// fija el TTL. Fail-OPEN si Redis cae (no bloquear usuarios legítimos).
import { redisIncr } from './redis';

export async function redisRateLimit(bucket, id, limit, windowSec) {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${bucket}:${id}:${win}`;
  const count = await redisIncr(key, windowSec); // INCR (+EXPIRE en el primero)
  if (count === null) return { success: true, remaining: limit, reset: 0 }; // Redis caído → fail-open
  return {
    success: count <= limit,
    remaining: Math.max(0, limit - count),
    reset: (win + 1) * windowSec * 1000,
  };
}

// Helper: IP del request (primer hop de x-forwarded-for).
export function clientIp(request) {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || 'anonymous';
}
