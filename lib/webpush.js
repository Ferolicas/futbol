import webpush from 'web-push';

let initialized = false;

function init() {
  if (initialized) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return;
  webpush.setVapidDetails('mailto:ferneyolicas@gmail.com', pub, priv);
  initialized = true;
}

export const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';

/**
 * Send a push notification to one subscription.
 * Returns true on success, 'expired' if the subscription is gone, false on error.
 */
export async function sendPushNotification(subscription, payload) {
  init();
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) return 'expired';
    console.error('[PUSH] sendNotification error:', e.message);
    return false;
  }
}
