// Force-activate immediately on install so updated SW takes effect without waiting for tab close
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'CFanalisis', {
      body: data.body || '',
      icon: '/vflogo.png',
      badge: '/vflogo.png',
      tag: data.tag || 'goal',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: '/dashboard' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('/dashboard') && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/dashboard');
    })
  );
});
