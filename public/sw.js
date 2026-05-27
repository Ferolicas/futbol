// CFanalisis Service Worker — push + renovación de suscripción.
// v2 (2026-05-27): añadido pushsubscriptionchange para renovar suscripciones
// que el navegador rota/caduca (lo que pasa con permisos aprobados hace meses).

// Activación inmediata: el SW nuevo toma efecto sin esperar a cerrar pestañas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// VAPID key (base64url) → Uint8Array para pushManager.subscribe.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

self.addEventListener('push', event => {
  const data = (() => { try { return event.data?.json() || {}; } catch { return {}; } })();
  event.waitUntil(
    self.registration.showNotification(data.title || 'CFanalisis', {
      body: data.body || '',
      icon: '/vflogo.png',
      badge: '/vflogo.png',
      tag: data.tag || 'goal',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: data.url || '/dashboard' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/dashboard';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('/dashboard') && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── RENOVACIÓN AUTOMÁTICA ──────────────────────────────────────────────────
// El navegador dispara 'pushsubscriptionchange' cuando rota o caduca la
// suscripción (típico con permisos aprobados hace mucho). Sin este handler la
// suscripción muere en silencio. Aquí re-suscribimos y lo guardamos en el
// servidor, intentando dos rutas para garantizar la renovación:
//   1) /api/push/renew con el endpoint VIEJO → swap sin requerir sesión (el
//      endpoint viejo basta como prueba de propiedad; útil si la cookie de
//      sesión ya expiró en la PWA dormida).
//   2) /api/push/subscribe autenticado (cookies) como respaldo.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      // Clave VAPID desde el servidor (el SW no tiene acceso al env).
      const keyRes = await fetch('/api/push/subscribe', { method: 'GET' });
      const { vapidPublicKey } = await keyRes.json().catch(() => ({}));
      if (!vapidPublicKey) return;

      const oldEndpoint = event.oldSubscription?.endpoint || null;

      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      // Ruta 1: swap por endpoint viejo (no requiere auth).
      if (oldEndpoint) {
        await fetch('/api/push/renew', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldEndpoint, subscription: newSub }),
        }).catch(() => {});
      }
      // Ruta 2: guardar autenticado (respaldo; dedup por endpoint en servidor).
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSub),
      }).catch(() => {});
    } catch (e) {
      // best-effort: si falla, la re-validación al abrir la app lo recupera.
    }
  })());
});
