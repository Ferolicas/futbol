'use client';

import { useEffect, useRef, useState } from 'react';
import {
  REALTIME_WS_PROTOCOL,
  REALTIME_WS_TOKEN_PREFIX,
} from '@cfanalisis/realtime-protocol';

/**
 * Singleton de conexion WebSocket al worker en VPS.
 *
 * Una sola conexion por pestana (compartida entre componentes via el hook
 * useWorkerEvent). Maneja:
 *   - Autenticación con JWT de 5 minutos obtenido desde la sesión httpOnly.
 *     El token viaja como subprotocolo WebSocket, nunca en la URL ni en logs.
 *   - Reconexion automatica con backoff exponencial 1s→2s→4s→8s→16s→30s.
 *   - Heartbeat ping cada 25s (la mayoria de proxies cortan a 30s sin
 *     trafico).
 *   - Dispatch de eventos por (topic, event) a handlers suscritos.
 */

const WS_URL = process.env.NEXT_PUBLIC_WORKER_WS_URL;
const TOKEN_ENDPOINT = '/api/realtime/token';
const TOKEN_REFRESH_MARGIN_MS = 30_000;

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
    this.tokenRefreshTimer = null;
    this.shouldRun = false;
    this.connecting = false;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
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
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    if (this.ws) {
      try { this.ws.close(1000, 'client-stop'); } catch {}
      this.ws = null;
    }
    this.setState('disconnected');
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.accessToken;
    }
    const response = await fetch(TOKEN_ENDPOINT, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`token_${response.status}`);
    const data = await response.json();
    const expiresAt = Date.parse(data?.expiresAt || '');
    if (typeof data?.token !== 'string' || data.token.length < 80 || !Number.isFinite(expiresAt)) {
      throw new Error('token_invalid');
    }
    this.accessToken = data.token;
    this.accessTokenExpiresAt = expiresAt;
    return data.token;
  }

  scheduleTokenRefresh() {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    const delay = Math.max(1_000, this.accessTokenExpiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS);
    this.tokenRefreshTimer = setTimeout(() => {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.close(4001, 'token-refresh');
      } else if (this.shouldRun) {
        this.connect();
      }
    }, delay);
  }

  async connect() {
    // El staging privado reutiliza los assets inmutables de producción, pero
    // nunca debe abrir el gateway realtime LIVE con credenciales de staging.
    if (process.env.NODE_ENV === 'production' &&
        !['cfanalisis.com', 'www.cfanalisis.com'].includes(window.location.hostname)) {
      this.setState('disconnected');
      return;
    }
    if (!WS_URL) {
      console.warn('[ws] NEXT_PUBLIC_WORKER_WS_URL ausente');
      return;
    }
    if (!this.shouldRun || this.connecting || this.ws?.readyState === WebSocket.CONNECTING || this.ws?.readyState === WebSocket.OPEN) return;
    this.connecting = true;
    this.setState('connecting');

    let ws;
    try {
      const token = await this.getAccessToken();
      if (!this.shouldRun) return;
      const url = new URL(WS_URL, window.location.origin);
      url.search = '';
      url.hash = '';
      ws = new WebSocket(url.toString(), [
        REALTIME_WS_PROTOCOL,
        `${REALTIME_WS_TOKEN_PREFIX}${token}`,
      ]);
    } catch (error) {
      if (this.shouldRun) console.warn('[ws] autenticación o conexión no disponible:', error?.message);
      this.scheduleReconnect();
      return;
    } finally {
      this.connecting = false;
    }
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.setState('connected');
      // `getSocket()` puede abrir la conexión antes de que los hooks alcancen a
      // registrar sus topics. En ese caso los subscribe() ejecutados mientras
      // el socket estaba CONNECTING no pudieron enviarse. Re-sincronizar aquí
      // garantiza que toda conexión/reconexión quede realmente suscrita.
      for (const topic of this.topics) {
        this.send({ type: 'subscribe', topic });
      }
      this.startHeartbeat();
      this.scheduleTokenRefresh();
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

    ws.onclose = (event) => {
      this.stopHeartbeat();
      this.ws = null;
      if (event.code === 4401 || !opened) {
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
      }
      if (this.shouldRun) this.scheduleReconnect();
      else this.setState('disconnected');
    };

    ws.onerror = () => {
      // onclose se dispara despues; no hacemos nada extra aqui.
    };
  }

  scheduleReconnect() {
    this.setState('disconnected');
    if (!this.shouldRun || this.reconnectTimer) return;
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
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
