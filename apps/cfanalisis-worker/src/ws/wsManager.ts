/**
 * Gestor de WebSocket nativo — reemplaza Pusher.
 *
 * Topology:
 *   El cliente abre wss://worker.cfanalisis.com/ws con un JWT efímero en
 *   Sec-WebSocket-Protocol. El servidor valida firma, audiencia y expiración
 *   antes de llamar a wsManager.attach(socket, access).
 *   El cliente puede ampliar/reducir suscripciones en runtime enviando:
 *     {"type":"subscribe","topic":"chat-<userId>"}
 *     {"type":"unsubscribe","topic":"chat-<userId>"}
 *     {"type":"ping"}   → responde {"type":"pong"}
 *
 *   Los jobs llaman a wsManager.broadcast(topic, event, payload). Se envia
 *   a todos los sockets que estan suscritos a ese topic.
 *
 *   Wire format de broadcast (lo recibe el frontend):
 *     {"type":"event","topic":"live-scores","event":"update","data":{...}}
 *
 * Compatibilidad con la API anterior de Pusher (triggerEvent(channel, event,
 * data)) se mantiene en `triggerEvent` aqui — los jobs no cambian su
 * llamada, solo el transporte.
 */

import { makeRedisClient } from '../redis.js';
import {
  observeWsBroadcast,
  recordWsBackpressure,
  recordWsRejected,
} from '../metrics.js';

type Socket = {
  readyState: number;
  bufferedAmount?: number;
  send: (data: string) => void;
  on: (event: string, fn: (...args: any[]) => void) => void;
  ping?: () => void;
  terminate?: () => void;
  close: (code?: number, reason?: string) => void;
};

const OPEN = 1;
// RT-2: si un socket acumula >1MB de snapshots sin drenar, está atascado → se
// descarta el envío y se cierra (cliente muerto/lento). Los payloads live son
// pequeños, así que 1MB ya es muchísimo backlog.
const MAX_BUFFERED = 1_000_000; // 1MB
// RT-1: cada 30s se pinguea a cada socket; el que no devolvió pong desde el
// ciclo anterior se considera muerto y se termina.
const HEARTBEAT_INTERVAL = 30_000;
const MAX_CONTROL_MESSAGE_BYTES = 4_096;
const MAX_TOPIC_VIOLATIONS = 3;

type SocketAccess = {
  topics: Set<string>;
  allowedTopics: Set<string>;
  expiresAt: number;
  violations: number;
};

type AttachAccess = {
  allowedTopics: string[];
  expiresAt: number;
};

class WSManager {
  // topic → Set<socket>
  private subscriptions = new Map<string, Set<Socket>>();
  // socket → autorización y topics activos (para validar y limpiar al cerrar)
  private sockets = new Map<Socket, SocketAccess>();
  // RT-1: sockets que respondieron al último ping (liveness). Presente = vivo.
  private alive = new Set<Socket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startHeartbeat();
  }

  // RT-1: heartbeat/reaper. Idempotente. Cada ciclo: el socket que no devolvió
  // pong desde el ciclo anterior se da por muerto (terminate + detach); al resto
  // se le marca no-vivo y se le envía un ping (el evento 'pong' lo re-marca vivo).
  // Detecta conexiones medio-abiertas (móvil dormido, NAT, red caída) que de
  // otro modo no disparan 'close' y se quedan en los Map gastando memoria.
  startHeartbeat() {
    if (this.heartbeatTimer) return; // idempotente
    this.heartbeatTimer = setInterval(() => {
      // Snapshot: detach() muta this.sockets dentro del bucle.
      for (const socket of Array.from(this.sockets.keys())) {
        const access = this.sockets.get(socket);
        if (!access || access.expiresAt <= Date.now()) {
          try { socket.close(4401, 'token-expired'); } catch {}
          this.detach(socket);
          continue;
        }
        if (!this.alive.has(socket)) {
          try { socket.terminate?.(); } catch {}
          this.detach(socket);
          continue;
        }
        this.alive.delete(socket);
        try { socket.ping?.(); } catch {}
      }
    }, HEARTBEAT_INTERVAL);
    // No mantener vivo el proceso solo por este timer.
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  size() {
    return this.sockets.size;
  }

  topicSize(topic: string) {
    return this.subscriptions.get(topic)?.size ?? 0;
  }

  subscriptionCount() {
    let total = 0;
    for (const sockets of this.subscriptions.values()) total += sockets.size;
    return total;
  }

  attach(socket: Socket, access: AttachAccess) {
    if (!Number.isFinite(access.expiresAt) || access.expiresAt <= Date.now()) {
      recordWsRejected('expired');
      try { socket.close(4401, 'token-expired'); } catch {}
      return;
    }
    this.sockets.set(socket, {
      topics: new Set(),
      allowedTopics: new Set(access.allowedTopics),
      expiresAt: access.expiresAt,
      violations: 0,
    });
    // RT-1: nace vivo; cada 'pong' (respuesta al ping del servidor) lo re-marca.
    this.alive.add(socket);
    socket.on('pong', () => this.alive.add(socket));

    socket.on('message', (raw: Buffer | string) => {
      if (Buffer.byteLength(raw.toString()) > MAX_CONTROL_MESSAGE_BYTES) {
        try { socket.close(1009, 'message-too-large'); } catch {}
        this.detach(socket);
        return;
      }
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
        this.subscribe(socket, msg.topic);
      } else if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
        this.unsubscribe(socket, msg.topic);
      } else if (msg.type === 'ping') {
        if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    });

    socket.on('close', () => this.detach(socket));
    socket.on('error', () => this.detach(socket));

    // ACK al cliente para que sepa que la autenticacion paso.
    try {
      if (socket.readyState === OPEN) {
        socket.send(JSON.stringify({ type: 'connected', ts: Date.now(), expiresAt: access.expiresAt }));
      }
    } catch {}
  }

  subscribe(socket: Socket, topic: string): boolean {
    const access = this.sockets.get(socket);
    if (!access || !access.allowedTopics.has(topic)) {
      recordWsRejected('topic');
      if (access) {
        access.violations += 1;
        try {
          if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'error', code: 'forbidden_topic' }));
        } catch {}
        if (access.violations >= MAX_TOPIC_VIOLATIONS) {
          try { socket.close(4403, 'forbidden-topic'); } catch {}
          this.detach(socket);
        }
      }
      return false;
    }
    let set = this.subscriptions.get(topic);
    if (!set) { set = new Set(); this.subscriptions.set(topic, set); }
    set.add(socket);
    access.topics.add(topic);
    return true;
  }

  unsubscribe(socket: Socket, topic: string) {
    const set = this.subscriptions.get(topic);
    if (set) {
      set.delete(socket);
      if (set.size === 0) this.subscriptions.delete(topic);
    }
    const access = this.sockets.get(socket);
    if (access) access.topics.delete(topic);
  }

  detach(socket: Socket) {
    const access = this.sockets.get(socket);
    if (access) {
      for (const t of access.topics) {
        const set = this.subscriptions.get(t);
        if (set) {
          set.delete(socket);
          if (set.size === 0) this.subscriptions.delete(t);
        }
      }
    }
    this.sockets.delete(socket);
    this.alive.delete(socket);
  }

  broadcast(topic: string, event: string, data: unknown) {
    const set = this.subscriptions.get(topic);
    if (!set || set.size === 0) return 0;
    const payload = JSON.stringify({ type: 'event', topic, event, data });
    let delivered = 0;
    for (const socket of set) {
      try {
        if (socket.readyState !== OPEN) continue;
        // RT-2: backpressure. Si el cliente no drena (>1MB en buffer), está
        // atascado → no enviar, terminar y limpiar (cuenta como muerto).
        if ((socket.bufferedAmount ?? 0) > MAX_BUFFERED) {
          recordWsBackpressure();
          console.warn('[ws:backpressure] descarto socket atascado', { topic, event, buffered: socket.bufferedAmount });
          try { socket.terminate?.(); } catch {}
          this.detach(socket);
          continue;
        }
        socket.send(payload);
        delivered++;
      } catch {
        this.detach(socket);
      }
    }
    observeWsBroadcast(topic, event, delivered);
    return delivered;
  }
}

export const wsManager = new WSManager();

// ────────────────────────────────────────────────────────────────────────────
// Fan-out cross-proceso vía Redis pub/sub
//
// PROBLEMA: wsManager vive en la MEMORIA del proceso que tiene el servidor /ws
// (el proceso "realtime"). Al partir el worker en realtime + heavy (Fase 1),
// los jobs pesados (analyze, lineups, odds) corren en OTRO proceso y su
// triggerEvent local no alcanza a los sockets conectados en realtime.
//
// SOLUCIÓN: cada broadcast se publica en un canal Redis (`ws:fanout`); cada
// proceso tiene un suscriptor que reentrega a SUS sockets locales. Para no
// duplicar en el proceso de origen (que ya entregó local), el mensaje lleva su
// ORIGIN y el suscriptor ignora los propios.
//
// DEGRADACIÓN SEGURA: si el pub/sub no inicializa, triggerEvent sigue
// entregando local (idéntico al monolito de hoy). En modo monolítico ('all')
// el origen entrega local y se auto-ignora en el canal → exactamente una
// entrega, sin cambio de comportamiento.
// ────────────────────────────────────────────────────────────────────────────
const FANOUT_CHANNEL = 'ws:fanout';
const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

let fanoutPub: ReturnType<typeof makeRedisClient> | null = null;
try {
  fanoutPub = makeRedisClient();
  fanoutPub.on('error', (e: Error) => console.error('[ws:pub] error:', e.message));

  const fanoutSub = makeRedisClient();
  fanoutSub.on('error', (e: Error) => console.error('[ws:sub] error:', e.message));
  fanoutSub.subscribe(FANOUT_CHANNEL).catch((e: Error) =>
    console.error('[ws:sub] subscribe failed:', e.message));
  fanoutSub.on('message', (_channel: string, raw: string) => {
    try {
      const msg = JSON.parse(raw);
      // Mensaje propio → ya se entregó local en el origen. No re-entregar.
      if (!msg || msg.origin === ORIGIN) return;
      wsManager.broadcast(msg.topic, msg.event, msg.data);
    } catch (e) {
      console.error('[ws:sub] message handler:', (e as Error).message);
    }
  });
  console.log(`[ws] fan-out pub/sub activo (origin=${ORIGIN}, canal=${FANOUT_CHANNEL})`);
} catch (e) {
  console.error('[ws] fan-out pub/sub no disponible — modo solo-local:', (e as Error).message);
  fanoutPub = null;
}

// Drop-in replacement de lib/pusher.js triggerEvent(channel, event, data).
// Los jobs siguen llamando triggerEvent(...) — solo cambia el transporte.
export async function triggerEvent(channel: string, event: string, data: unknown) {
  // 1) Entrega LOCAL inmediata (sockets de ESTE proceso). Camino crítico de los
  //    eventos live (corren en el mismo proceso que el WS) y NO depende de
  //    Redis: si el pub/sub cae, esto sigue funcionando.
  try {
    wsManager.broadcast(channel, event, data);
  } catch (e) {
    console.error(`[ws] broadcast local ${channel}/${event}:`, (e as Error).message);
  }
  // 2) Publica para los OTROS procesos (heavy → realtime). Best-effort y
  //    fire-and-forget: NO se await-ea para que el camino caliente (broadcasts
  //    de live) no dependa ni en latencia del round-trip a Redis. Si falla,
  //    solo se pierde el cruce entre procesos de ESE evento; la entrega local
  //    del paso 1 ya ocurrió.
  if (fanoutPub) {
    fanoutPub
      .publish(FANOUT_CHANNEL, JSON.stringify({ origin: ORIGIN, topic: channel, event, data }))
      .catch((e: Error) => console.error(`[ws] publish ${channel}/${event}:`, e.message));
  }
}
