import webpush from 'web-push';

let initialized = false;

function init() {
  if (initialized) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:ferneyolicas@gmail.com',
    pub,
    priv,
  );
  initialized = true;
}

export const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';

// ── Metricas en memoria (resetean en cada restart) ────────────────────────
// Util para diagnostico via /api/admin/push-stats (TODO endpoint si quieres).
const metrics = {
  sent: 0,
  delivered: 0,
  expired: 0,
  failed: 0,
  byStatus: {},
};

export function getPushMetrics() {
  return { ...metrics, byStatus: { ...metrics.byStatus } };
}

/**
 * Send a push notification to one subscription.
 * Returns:
 *   - true        → entregado OK
 *   - 'expired'   → 410 Gone / 404 (caller debe limpiar de DB)
 *   - false       → error transitorio (retry next time)
 */
export async function sendPushNotification(subscription, payload, opts = {}) {
  init();
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    metrics.failed++;
    return false;
  }
  if (!subscription?.endpoint) {
    metrics.failed++;
    return false;
  }
  metrics.sent++;
  try {
    const json = JSON.stringify(payload);
    // TTL en segundos: cuanto tiempo guarda el push server (FCM/Apple) el
    // mensaje si el dispositivo esta offline. 4h para corners/goles —
    // notificacion vieja no aporta. Override con opts.ttl si quieres.
    const ttl = typeof opts.ttl === 'number' ? opts.ttl : 14400;
    await webpush.sendNotification(subscription, json, {
      TTL: ttl,
      urgency: opts.urgency || 'high',
      topic: opts.topic,  // si pasas un topic, FCM reemplaza notificaciones del mismo topic
    });
    metrics.delivered++;
    metrics.byStatus['ok'] = (metrics.byStatus['ok'] || 0) + 1;
    return true;
  } catch (e) {
    const status = e.statusCode || 0;
    metrics.byStatus[status] = (metrics.byStatus[status] || 0) + 1;
    if (status === 410 || status === 404) {
      // Suscripción muerta — el usuario revocó permiso, cambió de navegador,
      // o pasaron muchos meses sin actividad. Caller debe borrarla de la BD.
      metrics.expired++;
      return 'expired';
    }
    if (status === 401 || status === 403) {
      // VAPID keys malas — log explicito porque es bug de config.
      console.error('[PUSH] VAPID auth error', status, e.message);
    } else if (status === 413) {
      // Payload demasiado grande (>4KB tipico). Truncar y rsetry.
      console.error('[PUSH] payload too large', JSON.stringify(payload).length, 'bytes');
    } else if (status >= 500) {
      // Error transitorio del push server. Reintento en proxima iteracion.
      console.error('[PUSH] push server 5xx:', status, e.message);
    } else {
      console.error('[PUSH] sendNotification error:', status, e.message);
    }
    metrics.failed++;
    return false;
  }
}

/**
 * Envia el mismo payload a multiples subscriptions en paralelo, devuelve
 * arrays separados de delivered/expired/failed. Para limpieza atomica de
 * subscriptions expiradas el caller usa el array `expired`.
 *
 * Usar Promise.allSettled — un fallo en una sub NO cancela las demas.
 * Esto era un bug del flow viejo: si la primera sub expiraba con
 * sendPushNotification(...).catch(...) fuera del Promise.all, el resto
 * podia perderse silenciosamente.
 *
 * @param {Array} subs  — array de subscription objects
 * @param {Object} payload — title, body, tag, etc.
 * @param {Object} opts — TTL, urgency, topic (opcional)
 * @returns {{ delivered: string[], expired: string[], failed: string[] }}
 *   Arrays de endpoints en cada categoria.
 */
export async function sendPushNotificationBulk(subs, payload, opts = {}) {
  const results = await Promise.allSettled(
    (subs || []).map(sub => sendPushNotification(sub, payload, opts).then(r => ({ sub, result: r })))
  );

  const delivered = [];
  const expired = [];
  const failed = [];

  for (const r of results) {
    if (r.status !== 'fulfilled') {
      failed.push(r.reason?.message || 'unknown');
      continue;
    }
    const { sub, result } = r.value;
    const ep = sub?.endpoint || '';
    if (result === true) delivered.push(ep);
    else if (result === 'expired') expired.push(ep);
    else failed.push(ep);
  }

  return { delivered, expired, failed };
}
