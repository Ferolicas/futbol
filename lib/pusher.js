import Pusher from 'pusher';

// Server-side Pusher instance (triggers events)
let pusherInstance = null;

export function getPusher() {
  if (pusherInstance) return pusherInstance;

  if (!process.env.PUSHER_APP_ID || !process.env.PUSHER_KEY || !process.env.PUSHER_SECRET) {
    return null;
  }

  pusherInstance = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER || 'us2',
    useTLS: true,
  });

  return pusherInstance;
}

// Trigger a Pusher event (fire and forget)
export async function triggerEvent(channel, event, data) {
  const pusher = getPusher();
  if (!pusher) return;

  try {
    await pusher.trigger(channel, event, data);
  } catch (e) {
    console.error(`[PUSHER] Failed to trigger ${channel}/${event}:`, e.message);
  }
}
