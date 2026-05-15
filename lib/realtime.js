/**
 * realtime.js — emisor server-side de eventos realtime al worker.
 *
 * Reemplaza la antigua lib/pusher.js (que hablaba con la API de Pusher
 * directamente). Ahora el frontend de Vercel hace POST a
 *   <WORKER_URL>/broadcast
 * autenticado con WORKER_SECRET, y el worker en VPS hace el broadcast
 * por WebSocket a los clientes suscritos al canal/topic.
 *
 * Contrato identico al anterior: triggerEvent(channel, event, data).
 */

const DEFAULT_TIMEOUT_MS = 3000;

export async function triggerEvent(channel, event, data) {
  const url = process.env.WORKER_URL;
  const secret = process.env.WORKER_SECRET;
  if (!url || !secret) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[realtime] WORKER_URL o WORKER_SECRET ausentes — evento no emitido', { channel, event });
    }
    return;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    await fetch(`${url.replace(/\/$/, '')}/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ channel, event, data }),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (e) {
    console.error(`[realtime] broadcast ${channel}/${event} fallo:`, e.message);
  } finally {
    clearTimeout(t);
  }
}
