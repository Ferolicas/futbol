// Sentry client-side. Cargado automaticamente por @sentry/nextjs en el bundle del navegador.
// Sin NEXT_PUBLIC_SENTRY_DSN → init es no-op (Sentry lo detecta y desactiva todo).
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || 'production',
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0.05,
    replaysSessionSampleRate: 0, // sin replay en el plan free; cambiar a 0.05 cuando suba.
    replaysOnErrorSampleRate: 0,
  });
}
