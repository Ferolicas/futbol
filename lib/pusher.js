// Compatibilidad — antes este archivo hablaba con Pusher directamente.
// El proyecto migro a WebSocket nativo via el worker en VPS. Esta capa
// reexporta triggerEvent desde lib/realtime.js para no tener que renombrar
// los imports en API routes legados.
export { triggerEvent } from './realtime.js';

// getPusher se mantiene como no-op por si algun import residual sigue
// llamandolo; devolver null hace que las llamadas legacy sean ignoradas
// silenciosamente sin lanzar errores.
export function getPusher() {
  return null;
}
