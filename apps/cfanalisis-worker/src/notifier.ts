// @ts-nocheck
/**
 * notifier — envia alertas de error a Telegram con dedup distribuido.
 *
 * Configuracion via env:
 *   TELEGRAM_BOT_TOKEN        token del bot
 *   TELEGRAM_ALERT_CHAT_ID    chat ID destino (usuario personal, NO el canal)
 *
 * Sin esas vars → notifyError es no-op (solo loguea internamente).
 *
 * Dedup: Redis comparte el cooldown entre cfanalisis-rt y cfanalisis-heavy.
 * Un mismo error normal alerta como máximo cada 6 h. Los blips de
 * Redis/PostgreSQL se agrupan como un único incidente de infraestructura y
 * alertan como máximo cada 30 min, aunque fallen muchas colas a la vez.
 *
 * Memoria: el Map se purga cuando supera 500 entradas y elimina claves que
 * superaron dos veces el cooldown normal.
 */
import { createHash } from 'crypto';
import { logger } from './logger.js';
import { bullConnection } from './redis.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || '';
const COOLDOWN_MS = 6 * 60 * 60_000;
const INFRA_COOLDOWN_MS = 30 * 60_000;
const MAX_KEYS = 500;

const TRANSIENT_INFRA_RE = /(?:LOADING Redis|Redis is loading|connection (?:terminated|closed|reset)|ECONNREFUSED|ECONNRESET|EPIPE|database system is (?:starting|shutting down)|the database system is starting up|terminating connection due to administrator command|server closed the connection unexpectedly)/i;

const recent = new Map<string, number>();

function localShouldSend(key: string, cooldownMs: number): boolean {
  const now = Date.now();
  const last = recent.get(key);
  if (last && (now - last) < cooldownMs) return false;
  recent.set(key, now);
  if (recent.size > MAX_KEYS) {
    const cutoff = now - 2 * COOLDOWN_MS;
    for (const [k, t] of recent) if (t < cutoff) recent.delete(k);
  }
  return true;
}

async function shouldSend(key: string, cooldownMs: number): Promise<boolean> {
  if (!localShouldSend(key, cooldownMs)) return false;
  if (bullConnection.status !== 'ready') return true;

  const hash = createHash('sha256').update(key).digest('hex');
  try {
    const timeoutSentinel = Symbol('redis-dedup-timeout');
    const result = await Promise.race([
      bullConnection.set(`cf:telegram:dedup:${hash}`, '1', 'PX', cooldownMs, 'NX'),
      new Promise<symbol>((resolve) => {
        const timer = setTimeout(() => resolve(timeoutSentinel), 750);
        timer.unref?.();
      }),
    ]);
    if (result === timeoutSentinel) return true;
    return result === 'OK';
  } catch {
    // Redis puede ser precisamente el servicio que se está reiniciando. El
    // Map local mantiene como máximo una alerta por proceso durante ese blip.
    return true;
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export type ErrorContext = {
  /** 'job' | 'fastify' | 'process' — categoria gruesa */
  source: 'job' | 'fastify' | 'process' | string;
  /** nombre del job o ruta del endpoint */
  name?: string;
  /** id del job BullMQ si aplica */
  jobId?: string | number;
  /** datos extra para incluir en el mensaje (queue, method, etc.) */
  extra?: Record<string, unknown>;
};

export async function notifyError(ctx: ErrorContext, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : null;

  // Loguear siempre (independiente del envio a Telegram).
  logger.error(
    { source: ctx.source, name: ctx.name, jobId: ctx.jobId, extra: ctx.extra, err: msg, stack },
    `[${ctx.source}] ${ctx.name ?? ''} ${msg}`.trim(),
  );

  if (!BOT_TOKEN || !CHAT_ID) return;

  const infraTransient = TRANSIENT_INFRA_RE.test(msg);
  const key = infraTransient
    ? 'infra::redis-postgres-transient'
    : `${ctx.source}::${ctx.name ?? ''}::${msg.slice(0, 200)}`;
  const cooldownMs = infraTransient ? INFRA_COOLDOWN_MS : COOLDOWN_MS;
  if (!(await shouldSend(key, cooldownMs))) {
    logger.debug({ key }, 'notifyError dedup: skip Telegram (cooldown)');
    return;
  }

  const timestamp = new Date().toISOString();
  const lines = [
    `🔴 <b>cfanalisis</b> — error en <b>${escapeHtml(ctx.source)}</b>`,
    ctx.name ? `<b>${escapeHtml(ctx.name)}</b>` : null,
    ctx.jobId !== undefined ? `job <code>${escapeHtml(String(ctx.jobId))}</code>` : null,
    '',
    `<code>${escapeHtml(msg).slice(0, 1500)}</code>`,
    '',
    `<i>${escapeHtml(timestamp)}</i>`,
  ].filter(Boolean);

  const body = new URLSearchParams({
    chat_id: CHAT_ID,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  });

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: txt.slice(0, 200) }, 'notifyError: Telegram respondio !ok');
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'notifyError: fallo enviando a Telegram');
  }
}
