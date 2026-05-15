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

type Socket = {
  readyState: number;
  send: (data: string) => void;
  on: (event: string, fn: (...args: any[]) => void) => void;
  close: (code?: number, reason?: string) => void;
};

const OPEN = 1;

class WSManager {
  // topic → Set<socket>
  private subscriptions = new Map<string, Set<Socket>>();
  // socket → Set<topic>   (para limpiar al cerrar)
  private sockets = new Map<Socket, Set<string>>();

  size() {
    return this.sockets.size;
  }

  topicSize(topic: string) {
    return this.subscriptions.get(topic)?.size ?? 0;
  }

  attach(socket: Socket, topicsCsv?: string) {
    this.sockets.set(socket, new Set());

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
  }

  broadcast(topic: string, event: string, data: unknown) {
    const set = this.subscriptions.get(topic);
    if (!set || set.size === 0) return 0;
    const payload = JSON.stringify({ type: 'event', topic, event, data });
    let delivered = 0;
    for (const socket of set) {
      try {
        if (socket.readyState === OPEN) {
          socket.send(payload);
          delivered++;
        }
      } catch {
        this.detach(socket);
      }
    }
    return delivered;
  }
}

export const wsManager = new WSManager();

// Drop-in replacement de lib/pusher.js triggerEvent(channel, event, data).
// Los jobs siguen llamando triggerEvent(...) — solo cambia el transporte.
export async function triggerEvent(channel: string, event: string, data: unknown) {
  try {
    wsManager.broadcast(channel, event, data);
  } catch (e) {
    console.error(`[ws] broadcast ${channel}/${event} failed:`, (e as Error).message);
  }
}
