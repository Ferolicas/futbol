import { Redis as IORedis } from 'ioredis';

const host = process.env.REDIS_HOST || '127.0.0.1';
const port = Number(process.env.REDIS_PORT || 6379);
const password = process.env.REDIS_PASSWORD || undefined;

// BullMQ requires: maxRetriesPerRequest=null, enableReadyCheck=false
export const bullConnection = new IORedis({
  host,
  port,
  password,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

bullConnection.on('error', (err: Error) => {
  console.error('[redis] error:', err.message);
});

bullConnection.on('connect', () => {
  console.log(`[redis] connected to ${host}:${port}`);
});
