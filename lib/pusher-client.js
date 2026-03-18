'use client';

import PusherClient from 'pusher-js';

let pusherClient = null;

export function getPusherClient() {
  if (pusherClient) return pusherClient;

  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER || 'us2';

  if (!key) return null;

  pusherClient = new PusherClient(key, {
    cluster,
    forceTLS: true,
  });

  return pusherClient;
}
