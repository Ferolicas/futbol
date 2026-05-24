// Cargar .env del REPO RAÍZ explícitamente (no depender del cwd).
// El worker vive en /apps/futbol/apps/cfanalisis-worker pero el .env con
// VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/DATABASE_URL/etc está en /apps/futbol.
// Con cwd=worker dir, `import 'dotenv/config'` cargaría el .env LOCAL del
// worker (que puede no tener las VAPID) → web-push silenciosamente no enviaba.
// Resolvemos la ruta desde el archivo, así da igual el cwd.
import { config as dotenvConfig } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
// src/index.ts → /apps/futbol (subir 4 niveles desde dist/src/ tras tsc, o
// 3 desde src/ en tsx watch — probamos ambos, dotenv ignora archivos ausentes).
const repoRoot = resolve(__dirname, '../../../..');
const workerRoot = resolve(__dirname, '../..');
dotenvConfig({ path: resolve(workerRoot, '.env') });   // por si tiene overrides locales
dotenvConfig({ path: resolve(repoRoot, '.env'), override: false });

// logger primero — los modulos siguientes pueden usarlo en su top-level.
import { logger } from './logger.js';
import { notifyError } from './notifier.js';
import { buildServer } from './server.js';
import { startWorkers } from './workers.js';
import { registerSchedulers } from './schedulers.js';
import { bullConnection } from './redis.js';
import { queues } from './queues.js';

const PORT = Number(process.env.PORT || 8080);

async function main() {
  // Diagnóstico explícito de env críticos al arranque — sale en pm2 logs:
  const vapidPubLen = (process.env.VAPID_PUBLIC_KEY || '').length;
  const vapidPrivLen = (process.env.VAPID_PRIVATE_KEY || '').length;
  logger.info({
    repoRoot, workerRoot, cwd: process.cwd(),
    VAPID_PUBLIC_KEY: vapidPubLen ? `len=${vapidPubLen}` : 'MISSING',
    VAPID_PRIVATE_KEY: vapidPrivLen ? `len=${vapidPrivLen}` : 'MISSING',
    DATABASE_URL: process.env.DATABASE_URL ? 'set' : 'MISSING',
    FOOTBALL_API_KEY: process.env.FOOTBALL_API_KEY ? 'set' : 'MISSING',
  }, 'env diagnóstico al arranque');

  // Start HTTP enqueue server
  const app = buildServer();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  logger.info({ port: PORT }, 'HTTP server listening');

  // Start all BullMQ workers
  const workers = startWorkers();

  // Register native cron schedulers (replaces cron-job.org triggering)
  await registerSchedulers();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'received signal, shutting down…');
    try {
      await app.close();
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(Object.values(queues).map((q) => q.close()));
      await bullConnection.quit();
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'shutdown error');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  notifyError({ source: 'process', name: 'main' }, err)
    .finally(() => process.exit(1));
});

// Errores no manejados a nivel proceso — se loguean Y se mandan a Telegram
// (con dedup para no spamear si algo entra en loop).
process.on('uncaughtException', (err) => {
  notifyError({ source: 'process', name: 'uncaughtException' }, err).catch(() => {});
});
process.on('unhandledRejection', (reason) => {
  notifyError({ source: 'process', name: 'unhandledRejection' }, reason).catch(() => {});
});
