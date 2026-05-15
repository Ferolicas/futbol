// @ts-nocheck
import Fastify from 'fastify';
import os from 'os';
import { execSync } from 'child_process';
import { isValidQueue, queues, QUEUE_NAMES, type QueueName } from './queues.js';
import { getErrors } from './errors-log.js';
import { redisGet, pgQuery } from './shared.js';
import { bullConnection } from './redis.js';
import { logger } from './logger.js';
import { notifyError } from './notifier.js';
import { wsManager } from './ws/wsManager.js';
import { runFutbolCalibration } from './jobs/calibration/futbol.js';
import { runBaseballCalibration } from './jobs/calibration/baseball.js';

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

function getVpsStats() {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const loadAvg  = os.loadavg();
  const cores    = os.cpus().length;
  const cpuPct   = Math.min(100, Math.round((loadAvg[0] / cores) * 100));

  let diskTotal = 0, diskUsed = 0;
  try {
    const df = execSync('df -B1 / 2>/dev/null | tail -1', { timeout: 2000 }).toString().trim();
    const parts = df.split(/\s+/);
    diskTotal = parseInt(parts[1]) || 0;
    diskUsed  = parseInt(parts[2]) || 0;
  } catch { /* ignore */ }

  let processes = 0;
  try {
    processes = parseInt(execSync("ps aux | tail -n +2 | wc -l", { timeout: 2000 }).toString().trim()) || 0;
  } catch { /* ignore */ }

  return {
    ram: {
      total:   totalMem,
      used:    usedMem,
      free:    freeMem,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    cpu: {
      loadAvg1:  Math.round(loadAvg[0] * 100) / 100,
      loadAvg5:  Math.round(loadAvg[1] * 100) / 100,
      loadAvg15: Math.round(loadAvg[2] * 100) / 100,
      cores,
      percent: cpuPct,
    },
    disk: {
      total:   diskTotal,
      used:    diskUsed,
      free:    diskTotal - diskUsed,
      percent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0,
    },
    processes,
    uptimeSec: Math.round(os.uptime()),
  };
}

async function pingPostgres(): Promise<'ok' | 'error'> {
  try {
    const { rows } = await pgQuery('SELECT 1 AS one');
    return rows[0]?.one === 1 ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

async function pingRedis(): Promise<'ok' | 'error'> {
  try {
    const pong = await bullConnection.ping();
    return pong === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

async function collectHealthQueues() {
  const out: Record<string, { waiting: number; active: number; failed: number; completed: number }> = {};
  await Promise.all(QUEUE_NAMES.map(async (name) => {
    const q = queues[name];
    const [waiting, active, failed, completed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getFailedCount(),
      q.getCompletedCount(),
    ]);
    out[name] = { waiting, active, failed, completed };
  }));
  return out;
}

export function buildServer() {
  // Pino integrado como logger interno de Fastify — los req.log heredan el
  // mismo transport (stdout + LOG_FILE) que el resto del worker.
  const app = Fastify({ logger });

  // Errores en handlers Fastify → loguear + alerta Telegram (con dedup).
  app.setErrorHandler((err, req, reply) => {
    notifyError(
      { source: 'fastify', name: `${req.method} ${req.routerPath || req.url}`, extra: { url: req.url } },
      err,
    ).catch(() => {});
    reply.code(err.statusCode || 500).send({ ok: false, error: err.message });
  });

  // WebSocket plugin — registrado de forma sincrona dentro del ready chain.
  // `@fastify/websocket` se carga via dynamic import para que el server pueda
  // construirse aun si la dep no esta instalada (degradacion controlada).
  app.register(async (instance) => {
    try {
      const ws = await import('@fastify/websocket');
      await instance.register(ws.default ?? ws);
      instance.get('/ws', { websocket: true }, (conn, req) => {
        const query = req.query as { secret?: string; topics?: string };
        if (!SECRET || query.secret !== SECRET) {
          conn.socket.send(JSON.stringify({ type: 'error', code: 'unauthorized' }));
          conn.socket.close(4401, 'unauthorized');
          return;
        }
        wsManager.attach(conn.socket, query.topics);
      });
      logger.info('/ws registered');
    } catch (e) {
      logger.warn({ err: (e as Error).message }, '@fastify/websocket no disponible — /ws desactivado');
    }
  });

  app.get('/stats', async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: 'unauthorized' });
    return { ok: true, ts: new Date().toISOString(), ...getVpsStats() };
  });

  // /health — sin auth (lo usan BetterUptime, scripts locales, Caddy).
  app.get('/health', async (_req, reply) => {
    const startedAt = Date.now();
    const [db, redis, queuesSummary] = await Promise.all([
      pingPostgres(),
      pingRedis(),
      collectHealthQueues().catch(() => ({})),
    ]);
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;
    const status = (db === 'ok' && redis === 'ok') ? 'ok' : 'degraded';
    const body = {
      status,
      uptime: Math.round(process.uptime()),
      db, redis,
      queues: queuesSummary,
      memory: {
        used_mb:  Math.round(usedMem  / 1024 / 1024),
        total_mb: Math.round(totalMem / 1024 / 1024),
      },
      ws_clients: wsManager.size(),
      check_ms: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    };
    // Devuelve 200 incluso degraded — BetterUptime decide su umbral.
    return reply.code(200).send(body);
  });

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

  // Re-enqueue a single job (manual retry from the dashboard) OR enqueue a
  // fresh job in a queue when no jobId is provided.
  app.post('/admin/retry', async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (req.body || {}) as { queue?: string; jobId?: string; payload?: unknown };
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
      // Fresh job with optional payload from caller (e.g. {force: true} for
      // analyze-all-today).
      const job = await queues[body.queue].add(body.queue, body.payload ?? {});
      return { ok: true, enqueued: job.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ ok: false, error: msg });
    }
  });

  // Synchronous calibration. Builds + persists + returns {before, after,
  // per-market diff} so the dashboard can show what changed. Blocks the
  // request until done — typical run is a few seconds, occasionally up to
  // ~30s when the predictions table is large.
  app.post('/admin/calibrate', async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: 'unauthorized' });
    const sport = ((req.query as { sport?: string }).sport || 'futbol').toLowerCase();
    if (sport !== 'futbol' && sport !== 'baseball') {
      return reply.code(400).send({ error: 'sport must be futbol|baseball' });
    }
    const startedAt = Date.now();
    try {
      const result = sport === 'baseball'
        ? await runBaseballCalibration()
        : await runFutbolCalibration();
      return { ok: true, durationMs: Date.now() - startedAt, ...result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      req.log.error({ err: msg }, `/admin/calibrate ${sport} failed`);
      return reply.code(500).send({ ok: false, error: msg });
    }
  });

  // Broadcast desde Vercel — sustituye la llamada directa a Pusher
  // que hacian las API routes del frontend (ej. /api/chat).
  app.post('/broadcast', async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (req.body || {}) as { channel?: string; event?: string; data?: unknown };
    if (!body.channel || !body.event) {
      return reply.code(400).send({ error: 'channel y event son obligatorios' });
    }
    const delivered = wsManager.broadcast(body.channel, body.event, body.data ?? null);
    return { ok: true, channel: body.channel, event: body.event, delivered };
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
