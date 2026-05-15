'use client';

// Compatibilidad — `usePusherEvent` ahora usa WebSocket nativo via el worker.
// Mismo contrato: (channelName, eventName, callback) → suscripcion auto-limpiada.
// Los componentes que ya importan `usePusherEvent` no necesitan cambios.
export { useWorkerEvent as usePusherEvent } from '../hooks/useWorkerSocket';
