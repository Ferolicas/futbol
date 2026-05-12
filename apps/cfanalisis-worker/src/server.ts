// @ts-nocheck
import Fastify from 'fastify';
import { isValidQueue, queues, QUEUE_NAMES, type QueueName } from './queues.js';
import { getErrors } from './errors-log.js';
import { redisGet } from './shared.js';

const SECRET = process.env.WORKER_SECRET || '';

if (!SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('[server] WORKER_SECRET must be set in production');
}

function requireAuth(req): boolean {
  const auth = req.headers['authorization'];
  const token = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';
  return !SECRET || token === SECRET;
}

async function collectQueueOverview() {
  const rows = await Promise.all(QUEUE_NAMES.map(async (name: QueueName) => {
    const q = queues[name];
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
      q.getDelayedCount(),
    ]);
    return { name, waiting, active, completed, failed, delayed };
  }));
  return rows;
}

async function collectActiveJobs() {
  const all = [];
  for (const name of QUEUE_NAMES) {
    const jobs = await queues[name].getActive(0, 20);
    for (const job of jobs) {
      const progress = job.progress;
      const startedAt = job.processedOn ?? job.timestamp ?? Date.now();
      const elapsedMs = Date.now() - startedAt;
      let etaMs = null;
      // Progress is either a number (0-100) or an object set via job.updateProgress({...})
      const p = typeof progress === 'object' && progress !== null ? progress : null;
      const processed = p?.processed ?? null;
      const total = p?.total ?? null;
      if (processed && total && processed > 0) {
        etaMs = Math.max(0, Math.round((elapsedMs / processed) * (total - processed)));
      }
      all.push({
        id: job.id,
        queue: name,
        name: job.name,
        data: job.data,
        attemptsMade: job.attemptsMade,
        startedAt,
        elapsedMs,
        etaMs,
        progress: p ?? (typeof progress === 'number' ? progress : null),
      });
    }
  }
  return all;
}

async function collectRecentFailed(limit = 50) {
  const all = [];
  for (const name of QUEUE_NAMES) {
    const jobs = await queues[name].getFailed(0, limit);
    for (const job of jobs) {
      all.push({
        id: job.id,
        queue: name,
        name: job.name,
        data: job.data,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        finishedOn: job.finishedOn,
        stacktrace: Array.isArray(job.stacktrace) ? job.stacktrace[0] : null,
      });
    }
  }
  // newest first
  all.sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0));
  return all.slice(0, limit);
}

async function collectAnalysisStatus(date: string) {
  // fixtures:{date}      → all fixtures of the day (raw API-Football payload)
  // analysis:{date}      → { globallyAnalyzed: [fids], analyzedOdds, analyzedData }
  // dailyBatch:{date}    → { started, completed, fixtureCount }
  // errors:{date}:list   → recent errors (newest first, capped 500)
  const [fixtures, analysis, dailyBatch, errors] = await Promise.all([
    redisGet(`fixtures:${date}`),
    redisGet(`analysis:${date}`),
    redisGet(`dailyBatch:${date}`),
    getErrors(date),
  ]);

  const allFixtures = Array.isArray(fixtures) ? fixtures : [];
  const analyzedIds = new Set(
    (Array.isArray(analysis?.globallyAnalyzed) ? analysis.globallyAnalyzed : []).map(Number),
  );

  const summary = (f) => ({
    fixtureId: Number(f.fixture.id),
    homeTeam: f.teams?.home?.name,
    awayTeam: f.teams?.away?.name,
    homeLogo: f.teams?.home?.logo,
    awayLogo: f.teams?.away?.logo,
    league: f.league?.name,
    leagueLogo: f.league?.logo,
    country: f.league?.country,
    kickoff: f.fixture?.date,
    status: f.fixture?.status?.short,
  });

  const analyzed = [];
  const pending = [];
  for (const f of allFixtures) {
    const fid = Number(f.fixture.id);
    if (analyzedIds.has(fid)) analyzed.push(summary(f));
    else pending.push(summary(f));
  }

  // Sort pending by kickoff ascending (closest first)
  pending.sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());

  return {
    date,
    total: allFixtures.length,
    analyzedCount: analyzed.length,
    pendingCount: pending.length,
    completed: dailyBatch?.completed === true,
    startedAt: dailyBatch?.startedAt ?? null,
    completedAt: dailyBatch?.completedAt ?? null,
    pending,
    errors,
  };
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

  // === Admin dashboard ===
  // Returns everything the /ferney page needs in a single call.
  // Defaults `date` to today UTC if not provided.
  app.get('/admin/status', async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: 'unauthorized' });
    const date = (req.query as { date?: string }).date
      || new Date().toISOString().split('T')[0];
    try {
      const [queuesOverview, activeJobs, failedJobs, analysis] = await Promise.all([
        collectQueueOverview(),
        collectActiveJobs(),
        collectRecentFailed(50),
        collectAnalysisStatus(date),
      ]);
      return {
        ok: true,
        ts: new Date().toISOString(),
        uptimeSec: process.uptime(),
        queues: queuesOverview,
        activeJobs,
        failedJobs,
        analysis,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      req.log.error({ err: msg }, '/admin/status failed');
      return reply.code(500).send({ ok: false, error: msg });
    }
  });

  // Re-enqueue a single job (manual retry from the dashboard)
  app.post('/admin/retry', async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (req.body || {}) as { queue?: string; jobId?: string };
    if (!body.queue || !isValidQueue(body.queue)) {
      return reply.code(400).send({ error: 'queue invalid' });
    }
    try {
      if (body.jobId) {
        const job = await queues[body.queue].getJob(body.jobId);
        if (!job) return reply.code(404).send({ error: 'job not found' });
        await job.retry();
        return { ok: true, retried: body.jobId };
      }
      // No jobId → enqueue a fresh job in that queue (useful for "run now" buttons)
      const job = await queues[body.queue].add(body.queue, body || {});
      return { ok: true, enqueued: job.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, error: msg });
    }
  });

  app.post('/enqueue/:queue', async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: 'unauthorized' });

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
