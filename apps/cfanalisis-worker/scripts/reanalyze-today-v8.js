// scripts/reanalyze-today-v8.js — operacion del worker (NO HTTP).
//
// Encola directamente un job `futbol-analyze-all-today` en la cola BullMQ
// local del VPS. Asi el script no depende de variables de Vercel
// (NEXT_PUBLIC_APP_URL, CRON_SECRET) ni hace HTTP — solo abre una conexion
// a Redis 127.0.0.1:6379 y empuja el job. El worker lo recoge y lo procesa
// con la concurrencia normal (analyze-all-today, concurrency=1, attempts=5).
//
// USO (desde el VPS, en /apps/futbol/apps/cfanalisis-worker):
//   node scripts/reanalyze-today-v8.js                # hoy (UTC)
//   node scripts/reanalyze-today-v8.js 2026-05-15     # fecha concreta
//   node scripts/reanalyze-today-v8.js --no-force     # sin force (skipea analyzed)
//
// El job futbol-analyze-all-today por defecto se queda con force=true para
// invalidar los cache_version=7 anteriores. Con --no-force solo re-analiza
// los que faltan.
//
// Conexion Redis:
//   Lee REDIS_HOST / REDIS_PORT / REDIS_PASSWORD del .env del worker
//   (../.env relativo a este script). Mismos valores que usa src/redis.ts.

import 'dotenv/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// ── Parseo de args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const force = !args.includes('--no-force');
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date = dateArg || new Date().toISOString().split('T')[0];

// ── Conexion Redis (mismas opciones que src/redis.ts) ────────────────────
const host = process.env.REDIS_HOST || '127.0.0.1';
const port = Number(process.env.REDIS_PORT || 6379);
const password = process.env.REDIS_PASSWORD || undefined;

const connection = new IORedis({
  host,
  port,
  password,
  // BullMQ exige estas opciones — sin ellas, las queues rechazan operar.
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on('error', (err) => {
  console.error(`[reanalyze-v8] redis error: ${err.message}`);
});

// ── Encolar el job ────────────────────────────────────────────────────────
const QUEUE_NAME = 'futbol-analyze-all-today';

async function main() {
  console.log(`[reanalyze-v8] connecting to redis ${host}:${port}…`);
  const queue = new Queue(QUEUE_NAME, {
    connection,
    // Hereda las opciones por defecto que define src/queues.ts cuando el
    // worker procese el job (attempts:5, exponential backoff). No las
    // duplicamos aqui — el processor las aplica al detectar el job.
  });

  try {
    const payload = { date, force };
    const job = await queue.add('analyze-all-today', payload, {
      // Si por error se intenta encolar dos veces seguidas con el mismo
      // (date, force), evitamos duplicados.
      jobId: `manual-reanalyze-v8-${date}-${force ? 'force' : 'soft'}`,
      removeOnComplete: { count: 50, age: 24 * 3600 },
      removeOnFail: { count: 100, age: 7 * 24 * 3600 },
    });

    console.log(`[reanalyze-v8] enqueued OK`);
    console.log(`  queue:   ${QUEUE_NAME}`);
    console.log(`  jobId:   ${job.id}`);
    console.log(`  payload: ${JSON.stringify(payload)}`);
    console.log('');
    console.log('[reanalyze-v8] follow progress:');
    console.log('  pm2 logs cfanalisis-worker --lines 200');
    console.log('  o en /ferney (panel admin)');
  } catch (e) {
    if (e?.message?.includes('Job') && e?.message?.includes('already exists')) {
      console.warn(`[reanalyze-v8] job ya existe para date=${date} force=${force}.`);
      console.warn('  Espera a que termine o usa: --no-force para soft-reanalyze,');
      console.warn('  o borra el job manualmente: redis-cli DEL bull:futbol-analyze-all-today:manual-reanalyze-v8-…');
    } else {
      console.error('[reanalyze-v8] enqueue failed:', e?.message || e);
      process.exitCode = 1;
    }
  } finally {
    await queue.close().catch(() => {});
    await connection.quit().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error('[reanalyze-v8] FATAL:', e?.message || e);
  try { await connection.quit(); } catch {}
  process.exit(1);
});
