import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from '@prometheus-io/client';
import type { QueueName } from './queues.js';

const registry = new Registry();
registry.setDefaultLabels({
  service: 'cfanalisis-worker',
  role: process.env.WORKER_ROLE || 'all',
});

collectDefaultMetrics({
  prefix: 'cfanalisis_',
  register: registry,
});

const httpRequests = new Counter({
  name: 'cfanalisis_http_requests_total',
  help: 'HTTP requests handled by the realtime gateway.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

const httpDuration = new Histogram({
  name: 'cfanalisis_http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const dependencyUp = new Gauge({
  name: 'cfanalisis_dependency_up',
  help: 'Whether a required dependency is reachable (1) or unavailable (0).',
  labelNames: ['dependency'] as const,
  registers: [registry],
});

const queueJobs = new Gauge({
  name: 'cfanalisis_queue_jobs',
  help: 'Current BullMQ job count by queue and state.',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});

const queueOldestActive = new Gauge({
  name: 'cfanalisis_queue_oldest_active_seconds',
  help: 'Age in seconds of the oldest active BullMQ job.',
  labelNames: ['queue'] as const,
  registers: [registry],
});

const wsConnections = new Gauge({
  name: 'cfanalisis_ws_connections',
  help: 'Current authenticated WebSocket connections.',
  registers: [registry],
});

const wsSubscriptions = new Gauge({
  name: 'cfanalisis_ws_subscriptions',
  help: 'Current WebSocket topic subscriptions.',
  registers: [registry],
});

const wsBroadcasts = new Counter({
  name: 'cfanalisis_ws_broadcasts_total',
  help: 'WebSocket broadcasts and delivered messages.',
  labelNames: ['topic', 'event'] as const,
  registers: [registry],
});

const wsDeliveries = new Counter({
  name: 'cfanalisis_ws_deliveries_total',
  help: 'WebSocket messages delivered to clients.',
  labelNames: ['topic', 'event'] as const,
  registers: [registry],
});

const wsRejected = new Counter({
  name: 'cfanalisis_ws_rejected_total',
  help: 'Rejected WebSocket authentication or topic operations.',
  labelNames: ['reason'] as const,
  registers: [registry],
});

const wsBackpressure = new Counter({
  name: 'cfanalisis_ws_backpressure_disconnects_total',
  help: 'WebSocket clients disconnected after exceeding the buffer limit.',
  registers: [registry],
});

const fixtureDeltas = new Counter({
  name: 'cfanalisis_fixture_deltas_total',
  help: 'Per-fixture realtime deltas published.',
  labelNames: ['source'] as const,
  registers: [registry],
});

const jobsFinished = new Counter({
  name: 'cfanalisis_jobs_finished_total',
  help: 'BullMQ jobs completed or terminally failed.',
  labelNames: ['queue', 'outcome'] as const,
  registers: [registry],
});

const jobDuration = new Histogram({
  name: 'cfanalisis_job_duration_seconds',
  help: 'BullMQ job execution time in seconds.',
  labelNames: ['queue', 'outcome'] as const,
  buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 180, 600, 1800, 3600],
  registers: [registry],
});

type QueueMetric = {
  waiting: number;
  active: number;
  failed: number;
  completed: number;
  oldest_active_ms: number | null;
};

export type MetricsSnapshot = {
  postgresUp: boolean;
  redisUp: boolean;
  queues: Partial<Record<QueueName, QueueMetric>>;
  websocketConnections: number;
  websocketSubscriptions: number;
};

export function observeHttpRequest(method: string, route: string, status: number, seconds: number): void {
  const labels = { method, route, status: String(status) };
  httpRequests.inc(labels);
  httpDuration.observe(labels, seconds);
}

export function observeWsBroadcast(topic: string, event: string, delivered: number): void {
  wsBroadcasts.inc({ topic, event });
  if (delivered > 0) wsDeliveries.inc({ topic, event }, delivered);
}

export function recordWsRejected(reason: 'authentication' | 'topic' | 'expired'): void {
  wsRejected.inc({ reason });
}

export function recordWsBackpressure(): void {
  wsBackpressure.inc();
}

export function recordFixtureDeltas(source: string | undefined, count: number): void {
  if (count > 0) fixtureDeltas.inc({ source: source || 'unknown' }, count);
}

export function recordJobFinished(queue: QueueName, outcome: 'completed' | 'failed', processedOn?: number): void {
  jobsFinished.inc({ queue, outcome });
  if (processedOn) {
    jobDuration.observe({ queue, outcome }, Math.max(0, Date.now() - processedOn) / 1000);
  }
}

export async function renderMetrics(snapshot: MetricsSnapshot): Promise<string> {
  dependencyUp.set({ dependency: 'postgresql' }, snapshot.postgresUp ? 1 : 0);
  dependencyUp.set({ dependency: 'redis' }, snapshot.redisUp ? 1 : 0);
  wsConnections.set(snapshot.websocketConnections);
  wsSubscriptions.set(snapshot.websocketSubscriptions);

  for (const [queue, values] of Object.entries(snapshot.queues)) {
    if (!values) continue;
    queueJobs.set({ queue, state: 'waiting' }, values.waiting);
    queueJobs.set({ queue, state: 'active' }, values.active);
    queueJobs.set({ queue, state: 'failed' }, values.failed);
    queueJobs.set({ queue, state: 'completed' }, values.completed);
    queueOldestActive.set({ queue }, Math.max(0, values.oldest_active_ms || 0) / 1000);
  }

  return registry.metrics();
}

export const metricsContentType = registry.contentType;
