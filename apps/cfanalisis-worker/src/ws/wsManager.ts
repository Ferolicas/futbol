// @ts-nocheck
/**
 * Gestor de WebSocket nativo — reemplaza Pusher.
 *
 * Topology:
 *   El cliente abre wss://worker.cfanalisis.com/ws?secret=...&topics=t1,t2
 *   El servidor autentica (en server.ts) y llama a wsManager.attach(socket, topics).
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

class WSManager {
  // topic → Set<socket>
  private subscriptions = new Map<string, Set<Socket>>();
  // socket → Set<topic>   (para limpiar al cerrar)
  private sockets = new Map<Socket, Set<string>>();
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

  attach(socket: Socket, topicsCsv?: string) {
    this.sockets.set(socket, new Set());
    // RT-1: nace vivo; cada 'pong' (respuesta al ping del servidor) lo re-marca.
    this.alive.add(socket);
    socket.on('pong', () => this.alive.add(socket));

    socket.on('message', (raw: Buffer | string) => {
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

    // Suscripciones iniciales pasadas por query param.
    if (topicsCsv) {
      for (const t of topicsCsv.split(',').map((s) => s.trim()).filter(Boolean)) {
        this.subscribe(socket, t);
      }
    }

    // ACK al cliente para que sepa que la autenticacion paso.
    try {
      if (socket.readyState === OPEN) {
        socket.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
      }
    } catch {}
  }

  subscribe(socket: Socket, topic: string) {
    let set = this.subscriptions.get(topic);
    if (!set) { set = new Set(); this.subscriptions.set(topic, set); }
    set.add(socket);
    const stopics = this.sockets.get(socket);
    if (stopics) stopics.add(topic);
  }

  unsubscribe(socket: Socket, topic: string) {
    const set = this.subscriptions.get(topic);
    if (set) {
      set.delete(socket);
      if (set.size === 0) this.subscriptions.delete(topic);
    }
    const stopics = this.sockets.get(socket);
    if (stopics) stopics.delete(topic);
  }

  detach(socket: Socket) {
    const topics = this.sockets.get(socket);
    if (topics) {
      for (const t of topics) {
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
