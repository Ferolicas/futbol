// @ts-nocheck
/**
 * Sentry initialization.
 *
 * Importado DESDE EL TOPE de src/index.ts antes que cualquier otro modulo
 * propio (Fastify, BullMQ, jobs). Esto permite capturar errores de
 * inicializacion (DATABASE_URL ausente, ioredis no conecta, etc.).
 *
 * Sin SENTRY_DSN en el entorno → no-op (export Sentry vacio). Esto permite
 * dejar el codigo de captura sembrado en jobs y servidor sin requerir
 * Sentry para el desarrollo local.
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.SENTRY_RELEASE || process.env.npm_package_version,
    // 10% de trazas en prod — barato y representativo. Subir si hace falta.
    tracesSampleRate: 0.1,
    // No mandar PII por defecto (los jobs procesan datos publicos de
    // partidos; los user_ids ya van enmascarados via JSON.stringify).
    sendDefaultPii: false,
  });
  console.log('[sentry] initialized');
} else {
  console.log('[sentry] SENTRY_DSN not set, error tracking disabled');
}

export { Sentry };

export function captureJobException(err: unknown, ctx: { queue: string; jobId?: string | number; data?: unknown }) {
  if (!dsn) return;
  Sentry.withScope((scope) => {
    scope.setTag('queue', ctx.queue);
    if (ctx.jobId !== undefined) scope.setTag('jobId', String(ctx.jobId));
    if (ctx.data !== undefined) scope.setContext('jobData', { data: ctx.data });
    Sentry.captureException(err);
  });
}
