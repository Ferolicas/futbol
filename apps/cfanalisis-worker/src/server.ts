import Fastify from 'fastify';
import { isValidQueue, queues, QUEUE_NAMES } from './queues.js';

const SECRET = process.env.WORKER_SECRET || '';

if (!SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('[server] WORKER_SECRET must be set in production');
}

export function buildServer() {
  const app = Fastify({ logger: { level: 'info' } });

  app.get('/health', async () => ({
    ok: true,
    uptime: process.uptime(),
    queues: QUEUE_NAMES,
    timestamp: new Date().toISOString(),
  }));

  app.get('/queues/:name/status', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!isValidQueue(name)) return reply.code(404).send({ error: 'unknown queue' });
    const q = queues[name];
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
      q.getDelayedCount(),
    ]);
    return { queue: name, waiting, active, completed, failed, delayed };
  });

  app.post('/enqueue/:queue', async (req, reply) => {
    // Auth
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';
    if (SECRET && token !== SECRET) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const queueName = (req.params as { queue: string }).queue;
    if (!isValidQueue(queueName)) {
      return reply.code(404).send({ error: 'unknown queue', queue: queueName });
    }

    const body = (req.body || {}) as {
      payload?: unknown;
      opts?: { jobId?: string; delay?: number; priority?: number };
      name?: string;
    };

    try {
      const job = await queues[queueName].add(
        body.name || queueName,
        body.payload ?? {},
        body.opts ?? {},
      );
      return { ok: true, queue: queueName, jobId: job.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      req.log.error({ err: msg }, 'enqueue failed');
      return reply.code(500).send({ ok: false, error: msg });
    }
  });

  return app;
}
