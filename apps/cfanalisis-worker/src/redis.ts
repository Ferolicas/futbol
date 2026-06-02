import { Redis as IORedis, type RedisOptions } from 'ioredis';

const host = process.env.REDIS_HOST || '127.0.0.1';
const port = Number(process.env.REDIS_PORT || 6379);
const password = process.env.REDIS_PASSWORD || undefined;

// Opciones base (host/port/password) compartidas por bullConnection y por las
// conexiones dedicadas de pub/sub del wsManager. Un cliente ioredis en modo
// `subscribe` queda bloqueado para comandos normales, por eso publisher y
// subscriber necesitan conexiones propias creadas con makeRedisClient().
export const redisOptions: RedisOptions = { host, port, password };

// BullMQ requires: maxRetriesPerRequest=null, enableReadyCheck=false
export const bullConnection = new IORedis({
  ...redisOptions,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Fábrica de conexiones Redis independientes (cada llamada = un socket TCP
// nuevo). La usa el fan-out WS para sus conexiones de publish/subscribe.
export function makeRedisClient(): IORedis {
  return new IORedis(redisOptions);
}

bullConnection.on('error', (err: Error) => {
  console.error('[redis] error:', err.message);
});

bullConnection.on('connect', () => {
  console.log(`[redis] connected to ${host}:${port}`);
});
