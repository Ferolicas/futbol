'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Singleton de conexion WebSocket al worker en VPS.
 *
 * Una sola conexion por pestana (compartida entre componentes via el hook
 * useWorkerEvent). Maneja:
 *   - Autenticacion con NEXT_PUBLIC_WORKER_SECRET en la URL (query param).
 *   - Reconexion automatica con backoff exponencial 1s→2s→4s→8s→16s→30s.
 *   - Heartbeat ping cada 25s (la mayoria de proxies cortan a 30s sin
 *     trafico).
 *   - Dispatch de eventos por (topic, event) a handlers suscritos.
 */

const WS_URL = process.env.NEXT_PUBLIC_WORKER_WS_URL;
const WS_SECRET = process.env.NEXT_PUBLIC_WORKER_SECRET;

class WorkerSocket {
  constructor() {
    this.ws = null;
    this.state = 'disconnected'; // 'connecting' | 'connected' | 'disconnected'
    this.attempt = 0;
    this.handlers = new Map(); // `${topic}::${event}` → Set<fn>
    this.topics = new Set();
    this.stateListeners = new Set();
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.shouldRun = false;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.stateListeners) {
      try { fn(s); } catch {}
    }
  }

  start() {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws) {
      try { this.ws.close(1000, 'client-stop'); } catch {}
      this.ws = null;
    }
    this.setState('disconnected');
  }

  connect() {
    if (!WS_URL || !WS_SECRET) {
      console.warn('[ws] NEXT_PUBLIC_WORKER_WS_URL o NEXT_PUBLIC_WORKER_SECRET ausentes');
      return;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this.setState('connecting');

    const initialTopics = [...this.topics].join(',');
    const url = `${WS_URL}?secret=${encodeURIComponent(WS_SECRET)}${
      initialTopics ? `&topics=${encodeURIComponent(initialTopics)}` : ''
    }`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) {
      console.error('[ws] no se pudo crear WebSocket:', e?.message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('connected');
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'event') {
        const key = `${msg.topic}::${msg.event}`;
        const set = this.handlers.get(key);
        if (set) {
          for (const fn of set) {
            try { fn(msg.data); } catch (e) { console.error('[ws] handler error:', e); }
          }
        }
      }
      // pong / connected / error → ignoramos silenciosamente
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      if (this.shouldRun) this.scheduleReconnect();
      else this.setState('disconnected');
    };

    ws.onerror = () => {
      // onclose se dispara despues; no hacemos nada extra aqui.
    };
  }

  scheduleReconnect() {
    this.setState('disconnected');
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === 1) {
        try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
    }, 25_000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  send(obj) {
    if (this.ws?.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch {}
    }
  }

  subscribe(topic) {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    this.send({ type: 'subscribe', topic });
  }

  unsubscribe(topic) {
    if (!this.topics.has(topic)) return;
    this.topics.delete(topic);
    this.send({ type: 'unsubscribe', topic });
  }

  onEvent(topic, event, fn) {
    const key = `${topic}::${event}`;
    let set = this.handlers.get(key);
    if (!set) { set = new Set(); this.handlers.set(key, set); }
    set.add(fn);
    return () => {
      const s = this.handlers.get(key);
      if (s) { s.delete(fn); if (s.size === 0) this.handlers.delete(key); }
    };
  }

  onState(fn) {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => { this.stateListeners.delete(fn); };
  }
}

let _singleton = null;
function getSocket() {
  if (typeof window === 'undefined') return null;
  if (!_singleton) {
    _singleton = new WorkerSocket();
    _singleton.start();
  }
  return _singleton;
}

/**
 * Sustituye usePusherEvent(channelName, eventName, callback).
 *
 * Mismo contrato: si channelName es null/falsy → no suscribe (util para
 * desactivar bajo condicion, ej. viendo una fecha pasada).
 */
export function useWorkerEvent(channelName, eventName, callback) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!channelName || !eventName) return;
    const sock = getSocket();
    if (!sock) return;

    sock.subscribe(channelName);
    const off = sock.onEvent(channelName, eventName, (data) => {
      callbackRef.current?.(data);
    });

    return () => {
      off();
      // No nos desuscribimos del topic — otros componentes pueden seguir
      // escuchandolo. Si en el futuro hace falta, contar refs por topic
      // y unsubscribe cuando llega a 0.
    };
  }, [channelName, eventName]);
}

/**
 * Estado de la conexion (para mostrar indicador "conectando…" si quieres).
 */
export function useWorkerSocketState() {
  const [state, setState] = useState('disconnected');
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    return sock.onState(setState);
  }, []);
  return state;
}
