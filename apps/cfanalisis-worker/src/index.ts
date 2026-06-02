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

// WORKER_ROLE define qué hace este proceso (Fase 1 — aislamiento):
//   'realtime' → servidor HTTP/WS + pollers live (futbol-live, baseball-live)
//   'heavy'    → el resto de colas (daily, analyze, retrain, finalize, …), SIN servidor
//   'all'      → monolito: servidor + todas las colas (comportamiento previo)
// Default 'all' para que, sin configurar nada en pm2, el proceso siga
// comportándose EXACTAMENTE como antes de la Fase 1.
const ROLE = ((process.env.WORKER_ROLE || 'all').toLowerCase()) as 'all' | 'realtime' | 'heavy';
const HAS_SERVER = ROLE === 'all' || ROLE === 'realtime';

async function main() {
  logger.info({ role: ROLE, hasServer: HAS_SERVER }, 'worker boot');

  // El servidor HTTP (/health, /ws, /enqueue, /broadcast, /admin) solo vive en
  // el proceso con servidor. El proceso 'heavy' no lo levanta: así un puerto no
  // colisiona y el realtime queda como único dueño del :8080 que ve Caddy.
  const app = HAS_SERVER ? buildServer() : null;
  if (app) {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info({ port: PORT }, 'HTTP server listening');
  }

  // Workers de las colas que correspondan al rol.
  const workers = startWorkers(ROLE);

  // Los schedulers (templates de cron) se registran UNA vez en Redis desde el
  // proceso con servidor (realtime/all) y persisten ahí; los Workers de cada
  // cola —estén en el proceso que estén— promueven sus jobs repetibles. 'heavy'
  // NO registra para evitar doble registro/carrera en el arranque.
  if (HAS_SERVER) {
    await registerSchedulers();
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'received signal, shutting down…');
    try {
      if (app) await app.close();
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
