import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../auth-context';
import { workerSocket, type SocketState } from './socket';

/** Arranca la conexión mientras exista sesión; la corta al cerrar sesión o pasar a segundo plano. */
export function useRealtimeLifecycle() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) { workerSocket.stop(); return; }
    workerSocket.start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') workerSocket.nudge();
    });
    return () => { sub.remove(); workerSocket.stop(); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Equivalente a usePusherEvent/useWorkerEvent de la web. */
export function useWorkerEvent(topic: string | null | undefined, event: string, callback: (data: any) => void) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    if (!topic || !event) return;
    workerSocket.subscribe(topic);
    return workerSocket.onEvent(topic, event, (data) => callbackRef.current?.(data));
  }, [topic, event]);
}

export function useWorkerSocketState(): SocketState {
  const [state, setState] = useState<SocketState>(workerSocket.state);
  useEffect(() => workerSocket.onState(setState), []);
  return state;
}
