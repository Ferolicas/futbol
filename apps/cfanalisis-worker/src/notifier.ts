// @ts-nocheck
/**
 * notifier — envia alertas de error a Telegram con dedup 1/min.
 *
 * Configuracion via env:
 *   TELEGRAM_BOT_TOKEN        token del bot
 *   TELEGRAM_ALERT_CHAT_ID    chat ID destino (usuario personal, NO el canal)
 *
 * Sin esas vars → notifyError es no-op (solo loguea internamente).
 *
 * Dedup: 1 alerta/minuto por (contexto + mensaje). Si el mismo error se
 * dispara 100 veces en un minuto, solo el primero se envia. La key se
 * construye con `${source}::${err_message.slice(0, 200)}` para que
 * mensajes similares pero de fuentes distintas no compartan cooldown.
 *
 * Memoria: el Map se purga cuando supera 500 entradas — borra todas las
 * que excedan 5x el cooldown (5 minutos). Suficiente para evitar memory
 * leak sin perder funcionalidad.
 */
import { logger } from './logger.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || '';
const COOLDOWN_MS = 60_000;
const MAX_KEYS = 500;

const recent = new Map<string, number>();

function shouldSend(key: string): boolean {
  const now = Date.now();
  const last = recent.get(key);
  if (last && (now - last) < COOLDOWN_MS) return false;
  recent.set(key, now);
  if (recent.size > MAX_KEYS) {
    const cutoff = now - 5 * COOLDOWN_MS;
    for (const [k, t] of recent) if (t < cutoff) recent.delete(k);
  }
  return true;
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

  const key = `${ctx.source}::${ctx.name ?? ''}::${msg.slice(0, 200)}`;
  if (!shouldSend(key)) {
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
