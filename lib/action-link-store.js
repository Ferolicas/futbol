'use client';

// Pub-sub mínimo para que el asistente ("Preguntar") dispare una acción del
// dashboard (ej. abrir "Cambiar contraseña") en el mismo momento del click,
// sin depender de navegar y de que la página vuelva a montarse para leer un
// query param — eso hacía que la acción solo apareciera tras refrescar.
const listeners = new Set();

export function triggerAppAction(action) {
  listeners.forEach((listener) => listener(action));
}

export function subscribeAppAction(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
