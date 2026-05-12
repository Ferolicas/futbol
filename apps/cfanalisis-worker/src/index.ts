import 'dotenv/config';
import { buildServer } from './server.js';
import { startWorkers } from './workers.js';
import { bullConnection } from './redis.js';
import { queues } from './queues.js';

const PORT = Number(process.env.PORT || 8080);

async function main() {
  // Start HTTP enqueue server
  const app = buildServer();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[worker] HTTP server listening on :${PORT}`);

  // Start all BullMQ workers
  const workers = startWorkers();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal}, shutting down…`);
    try {
      await app.close();
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(Object.values(queues).map((q) => q.close()));
      await bullConnection.quit();
    } catch (e) {
      console.error('[worker] shutdown error:', e);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
