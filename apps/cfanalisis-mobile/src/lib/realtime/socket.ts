import { WS_URL } from '../config';
import { api } from '../api';

// Mismo contrato que packages/realtime-protocol del repo web.
export const REALTIME_WS_PROTOCOL = 'cfanalisis-realtime-v1';
export const REALTIME_WS_TOKEN_PREFIX = 'cfjwt.';
const TOKEN_REFRESH_MARGIN_MS = 30_000;

export type SocketState = 'connecting' | 'connected' | 'disconnected';
type Handler = (data: any) => void;

/**
 * Conexión única al gateway realtime del worker. Autenticación con el JWT de
 * cinco minutos que emite /api/realtime/token (a partir de la sesión), enviado
 * como subprotocolo WebSocket. Reconexión con backoff y heartbeat cada 25 s.
 */
class WorkerSocket {
  private ws: WebSocket | null = null;
  state: SocketState = 'disconnected';
  private attempt = 0;
  private handlers = new Map<string, Set<Handler>>();
  private topics = new Set<string>();
  private stateListeners = new Set<(state: SocketState) => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;
  private connecting = false;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  lastEventAt = 0;

  private setState(state: SocketState) {
    if (this.state === state) return;
    this.state = state;
    for (const fn of this.stateListeners) { try { fn(state); } catch {} }
  }

  start() {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.reconnectTimer = null;
    this.tokenRefreshTimer = null;
    this.stopHeartbeat();
    if (this.ws) { try { this.ws.close(1000, 'client-stop'); } catch {} this.ws = null; }
    this.accessToken = null;
    this.setState('disconnected');
  }

  /** Fuerza una reconexión inmediata (p.ej. al volver a primer plano). */
  nudge() {
    if (!this.shouldRun) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.attempt = 0;
    this.connect();
  }

  private async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) return this.accessToken;
    const data = await api.get<{ token: string; expiresAt: string }>('/api/realtime/token');
    const expiresAt = Date.parse(data?.expiresAt || '');
    if (typeof data?.token !== 'string' || data.token.length < 80 || !Number.isFinite(expiresAt)) throw new Error('token_invalid');
    this.accessToken = data.token;
    this.accessTokenExpiresAt = expiresAt;
    return data.token;
  }

  private scheduleTokenRefresh() {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    const delay = Math.max(1_000, this.accessTokenExpiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS);
    this.tokenRefreshTimer = setTimeout(() => {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(4001, 'token-refresh');
      else if (this.shouldRun) this.connect();
    }, delay);
  }

  private async connect() {
    if (!WS_URL) return;
    if (!this.shouldRun || this.connecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    this.connecting = true;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      const token = await this.getAccessToken();
      if (!this.shouldRun) { this.connecting = false; return; }
      ws = new WebSocket(WS_URL, [REALTIME_WS_PROTOCOL, `${REALTIME_WS_TOKEN_PREFIX}${token}`]);
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.connecting = false;
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.setState('connected');
      for (const topic of this.topics) this.send({ type: 'subscribe', topic });
      this.startHeartbeat();
      this.scheduleTokenRefresh();
    };
    ws.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'event') {
        this.lastEventAt = Date.now();
        const set = this.handlers.get(`${msg.topic}::${msg.event}`);
        if (set) for (const fn of set) { try { fn(msg.data); } catch (error) { console.warn('[ws] handler', error); } }
      }
    };
    ws.onclose = (event) => {
      this.stopHeartbeat();
      this.ws = null;
      if (event.code === 4401 || !opened) { this.accessToken = null; this.accessTokenExpiresAt = 0; }
      if (this.shouldRun) this.scheduleReconnect(); else this.setState('disconnected');
    };
    ws.onerror = () => { /* onclose llega después */ };
  }

  private scheduleReconnect() {
    this.setState('disconnected');
    if (!this.shouldRun || this.reconnectTimer) return;
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) { try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch {} }
    }, 25_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) { try { this.ws.send(JSON.stringify(payload)); } catch {} }
  }

  subscribe(topic: string) {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    this.send({ type: 'subscribe', topic });
  }

  onEvent(topic: string, event: string, fn: Handler) {
    const key = `${topic}::${event}`;
    let set = this.handlers.get(key);
    if (!set) { set = new Set(); this.handlers.set(key, set); }
    set.add(fn);
    return () => {
      const current = this.handlers.get(key);
      if (current) { current.delete(fn); if (!current.size) this.handlers.delete(key); }
    };
  }

  onState(fn: (state: SocketState) => void) {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => { this.stateListeners.delete(fn); };
  }
}

export const workerSocket = new WorkerSocket();
