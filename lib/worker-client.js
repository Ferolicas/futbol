/**
 * Thin HTTP client used by /api/cron/* routes to enqueue jobs on the
 * BullMQ worker running on the VPS.
 *
 * Required env on Vercel:
 *   WORKER_URL    e.g. https://worker.cfanalisis.com
 *   WORKER_SECRET shared bearer token (must match WORKER_SECRET on the VPS)
 */

const DEFAULT_TIMEOUT_MS = 5000;

export async function enqueue(queue, payload = {}, opts = {}) {
  const url = process.env.WORKER_URL;
  const secret = process.env.WORKER_SECRET;

  if (!url || !secret) {
    console.error('[worker-client] WORKER_URL or WORKER_SECRET missing — job NOT enqueued', { queue });
    return { ok: false, error: 'worker_not_configured' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/enqueue/${encodeURIComponent(queue)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        payload,
        opts: opts.jobOpts || undefined,
        name: opts.name || undefined,
      }),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[worker-client] enqueue ${queue} failed:`, res.status, text);
      return { ok: false, error: `http_${res.status}`, detail: text };
    }
    return await res.json();
  } catch (e) {
    console.error(`[worker-client] enqueue ${queue} error:`, e.message);
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timeout);
  }
}
