'use client';

// Compatibilidad — antes este modulo creaba un cliente pusher-js singleton.
// Ahora todo el realtime va por WebSocket nativo via hooks/useWorkerSocket.
// Esta funcion devuelve null para que cualquier import residual no lance error.
// Si veis un null aqui en un componente nuevo, migrar a useWorkerEvent.
export function getPusherClient() {
  return null;
}
