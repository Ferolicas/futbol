// IMPORTANTE: env-bootstrap DEBE ser el primer import. En ESM todos los
// imports se evalúan en orden ANTES del código top-level, así que este
// import garantiza que el .env (resuelto por path absoluto, no por cwd) esté
// cargado antes de que cualquier otro módulo lea process.env. Si lo movemos
// abajo, lib/db.js leería DATABASE_URL=undefined al evaluar sus imports y
// crashearía con "DATABASE_URL is not set". Ver env-bootstrap.ts.
import './env-bootstrap.js';

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
