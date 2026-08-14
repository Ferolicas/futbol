// @ts-nocheck
/**
 * Job: futbol-live
 * Port of /api/cron/live. Polls live fixtures from API-Football, persists
 * stats to Redis + Supabase, sends realtime updates and curated push
 * notifications for favorited matches.
 *
 * Payload: {}
 */
import {
  ALL_LEAGUE_IDS, triggerEvent,
  redisGet, redisSet, redisDel, KEYS, TTL,
  incrementApiCallCount, sendPushNotification,
  supabaseAdmin, getMatchSchedule, pgQuery,
  footballApiRequest, extractResultCoverage,
} from '../../shared.js';
import {
  diffPlayerActivity,
  extractPlayerActivity,
  fixtureDetailBatches,
  mergePlayerActivity,
} from './live-player-activity.js';
import {
  cachedReconciliationKind,
  collectStaleLiveFixtureIds,
  shouldRejectStatusRegression,
} from './live-reconciliation.js';
import { queues } from '../../queues.js';

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];

async function enqueueImmediateFinalization(date, fixtureIds) {
  const unique = [...new Set((fixtureIds || []).map(Number).filter(Number.isFinite))];
  if (!date || unique.length === 0) return;

  const pending = [];
  for (const fid of unique) {
    const lockKey = `live:finalize-enqueued:${fid}`;
    if (await redisGet(lockKey).catch(() => null)) continue;
    await redisSet(lockKey, '1', 60 * 60).catch(() => {});
    pending.push(fid);
  }
  if (pending.length === 0) return;

  try {
    await queues['futbol-finalize'].add('futbol-finalize', {
      date,
      fixtureIds: pending,
      source: 'live-confirmed-final',
    });
    console.log(`[live:finalize] encolados fecha=${date} fixtures=${pending.join(',')}`);
  } catch (error) {
    await Promise.all(pending.map((fid) => redisDel(`live:finalize-enqueued:${fid}`).catch(() => {})));
    console.error('[live:finalize] no se pudo encolar cierre inmediato:', error.message);
  }
}

async function apiFetch(endpoint) {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return null;
  try {
    const result = await footballApiRequest(endpoint, {
      apiKey: key,
      timeoutMs: 20_000,
      retries: 2,
      priority: 'live',
    });
    return result.response;
  } catch (e) {
    // El primer DAILY_LIMIT real sí se registra. Durante el cooldown, el
    // cliente devuelve un skip local esperado (retryAfterMs) y no debe llenar
    // el error log tres veces por minuto ni una vez por fixture.
    if (!(e?.code === 'DAILY_LIMIT' && Number(e?.retryAfterMs) > 0)) {
      console.error('[live] apiFetch error:', endpoint, e.message);
    }
    return null;
  }
}

// Normalización de stat lookup — API-Football devuelve nombres de stat
// inconsistentes entre ligas (ej. "Corner Kicks" vs "Corners" vs "Corner",
// "Yellow Cards" vs "Yellowcards"). También a veces value llega como string
// "null" (truthy con ||) o como número string "5". Normalizamos todo aquí.
function statLookup(teamStats, ...candidates) {
  const arr = teamStats?.statistics;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = candidates.map(norm);
  for (const s of arr) {
    const t = norm(s.type);
    if (wanted.includes(t)) {
      const v = s.value;
      if (v === null || v === undefined || v === 'null' || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function extractLiveStats(match, events, stats) {
  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;
  const homeStats = (stats || []).find(s => s.team?.id === homeId);
  const awayStats = (stats || []).find(s => s.team?.id === awayId);

  // getVal con normalización flexible + soporte de aliases que API-Football
  // usa según liga. Si no hay dato → null (no 0). Caller hace fallback.
  const getVal = (teamStats, ...aliases) => statLookup(teamStats, ...aliases);

  const goalScorers = [], cardEvents = [], missedPenalties = [];
  // Stage notif: capturamos eventos discretos que API-Football reporta en
  // /fixtures?live=all (campo `events`). El team detection viene del propio
  // evento; el delta vs el tick anterior se calcula afuera en buildEventBundle.
  const substitutions = []; // { playerIn, playerOut, teamId, teamName, minute, extra }
  const varEvents = [];     // { detail, teamId, teamName, minute, extra, player }  detail: 'Goal cancelled' | 'Penalty cancelled' | 'Goal confirmed' | 'Penalty confirmed' …
  const penaltyEvents = []; // { kind: 'scored'|'missed'|'awarded', player, teamId, teamName, minute }

  for (const ev of (events || [])) {
    const baseInfo = {
      teamId: ev.team?.id,
      teamName: ev.team?.name,
      minute: ev.time?.elapsed,
      extra: ev.time?.extra,
      player: ev.player?.name,
      // playerId/assistId → foto oficial del jugador en el frontend
      // (media.api-sports.io/football/players/{id}.png).
      playerId: ev.player?.id ?? null,
      assist: ev.assist?.name ?? null,
      assistId: ev.assist?.id ?? null,
    };

    if (ev.type === 'Goal') {
      if (ev.detail === 'Missed Penalty') {
        missedPenalties.push(baseInfo);
        penaltyEvents.push({ ...baseInfo, kind: 'missed' });
      } else {
        goalScorers.push({ ...baseInfo, type: ev.detail });
        if (ev.detail === 'Penalty') {
          penaltyEvents.push({ ...baseInfo, kind: 'scored' });
        }
      }
    }
    if (ev.type === 'Card') {
      cardEvents.push({ ...baseInfo, type: ev.detail });
    }
    // Sustitución: API-Football usa type 'subst' (case-sensitive en la doc
    // pero algunos endpoints devuelven 'Subst'). Comparamos case-insensitive.
    if (typeof ev.type === 'string' && ev.type.toLowerCase() === 'subst') {
      substitutions.push({
        playerIn: ev.assist?.name || null,   // entra
        playerOut: ev.player?.name || null,  // sale
        teamId: ev.team?.id,
        teamName: ev.team?.name,
        minute: ev.time?.elapsed,
        extra: ev.time?.extra,
      });
    }
    // VAR: type 'Var', detail describe la decisión.
    if (typeof ev.type === 'string' && ev.type.toLowerCase() === 'var') {
      varEvents.push({ ...baseInfo, detail: ev.detail || 'VAR Review' });
    }
  }

  // Corners: ligas exóticas (Ucrania, China, Serbia, etc.) a veces NO devuelven
  // stats en /fixtures?live=all. Cuando getVal devuelve null, dejamos null
  // explícito para que el detalle batched `/fixtures?ids=...` o el snapshot
  // anterior puedan completarlo. NO usamos 0 como default
  // porque "0 corners en el min 80" sería un dato real, mientras que null = "no
  // sabemos". Esto distingue "API no reporta" vs "el partido realmente no tuvo".
  const coverage = extractResultCoverage({
    ...match,
    events: Array.isArray(events) ? events : [],
    statistics: Array.isArray(stats) ? stats : [],
  });
  const hCorners = coverage.corners.home;
  const aCorners = coverage.corners.away;
  const cornersAreReal = coverage.corners.total != null;

  // Cards: fallback a contar events SIEMPRE que stats no haya devuelto dato
  // explícito. El bug previo (`getVal(...) || count`) tiraba el 0 legítimo del
  // stat y caía al fallback, doblando el conteo. Ahora: si stat es null →
  // fallback events; si stat es 0 → 0 (real); si stat > 0 → ese valor.
  const hYellow = coverage.yellowCards.home;
  const aYellow = coverage.yellowCards.away;
  const hRed = coverage.redCards.home;
  const aRed = coverage.redCards.away;
  const yellowCardsAreReal = coverage.yellowCards.total != null;
  const redCardsAreReal = coverage.redCards.total != null;

  // Offsides: el contador de stats agrega offsides POR MINUTO sin dar jugador
  // ni jugada concreta. API-Football tampoco expone offsides como events
  // discretos (event.type='Offside' no existe). Por eso un push "🚫 Offside ·
  // Equipo" no aporta información real (¿quién? ¿en qué acción?). Decisión:
  // SE MANTIENEN los contadores aquí para consistencia del schema y para
  // mostrar el total en el dashboard, pero NO se notifican (ver
  // buildEventBundle más abajo). Si en el futuro la API empieza a exponerlos
  // como events con player, se puede reactivar la notificación.
  const hOffsidesRaw = getVal(homeStats, 'Offsides', 'Offside');
  const aOffsidesRaw = getVal(awayStats, 'Offsides', 'Offside');
  const hOffsides = hOffsidesRaw;
  const aOffsides = aOffsidesRaw;
  const offsidesAreReal = hOffsidesRaw !== null && aOffsidesRaw !== null;

  // Tiros / tiros a puerta / faltas: contadores agregados (sin minuto). Igual
  // que los córners, en el tick de HT su valor ES el total de la 1ª parte; se
  // capturan aquí para el snapshot durable de medio tiempo (persistHalfStatsSnapshot).
  // null explícito si la API no los reporta este tick (distinto de 0 real).
  const hShotsRaw = getVal(homeStats, 'Total Shots', 'Shots Total');
  const aShotsRaw = getVal(awayStats, 'Total Shots', 'Shots Total');
  const hShots = hShotsRaw, aShots = aShotsRaw;
  const shotsAreReal = hShotsRaw !== null && aShotsRaw !== null;
  const hSotRaw = getVal(homeStats, 'Shots on Goal', 'Shots on Target');
  const aSotRaw = getVal(awayStats, 'Shots on Goal', 'Shots on Target');
  const hSot = hSotRaw, aSot = aSotRaw;
  const sotAreReal = hSotRaw !== null && aSotRaw !== null;
  const hFoulsRaw = getVal(homeStats, 'Fouls', 'Fouls Committed');
  const aFoulsRaw = getVal(awayStats, 'Fouls', 'Fouls Committed');
  const hFouls = hFoulsRaw, aFouls = aFoulsRaw;
  const foulsAreReal = hFoulsRaw !== null && aFoulsRaw !== null;

  const counter = (home, away, isReal) => ({
    home,
    away,
    total: isReal ? home + away : null,
    isReal,
  });

  return {
    fixtureId: match.fixture.id,
    status: match.fixture.status,
    goals: match.goals,
    score: match.score,
    homeTeam: { id: homeId, name: match.teams.home.name },
    awayTeam: { id: awayId, name: match.teams.away.name },
    corners: counter(hCorners, aCorners, cornersAreReal),
    yellowCards: counter(hYellow, aYellow, yellowCardsAreReal),
    redCards: counter(hRed, aRed, redCardsAreReal),
    offsides: counter(hOffsides, aOffsides, offsidesAreReal),
    shots: counter(hShots, aShots, shotsAreReal),
    sot: counter(hSot, aSot, sotAreReal),
    fouls: counter(hFouls, aFouls, foulsAreReal),
    goalScorers,
    cardEvents,
    missedPenalties,
    substitutions,
    varEvents,
    penaltyEvents,
    updatedAt: new Date().toISOString(),
  };
}

function toSubArray(stored) {
  if (!stored) return [];
  const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ────────────────────────────────────────────────────────────────────────────
// Bundled push delivery — 1 push por fixture/tick que agrupa TODOS los
// deltas relevantes detectados desde el live anterior:
//   goles/anulados · córners · tarjetas · penaltis · faltas · remates.
// Las sustituciones y el VAR genérico se conservan en el snapshot interno,
// pero NO generan notificaciones.
//
// REGLA DE CALIDAD: solo notificamos eventos con datos REALES de API-Football
// (array `events` con jugador/equipo concretos). NO se notifican estadísticas
// agregadas sin contexto: los offsides siguen fuera. Para remates y faltas se
// comparan snapshots reales de `/fixtures?ids=...`, que incluye estadísticas
// por jugador donde la competición tiene cobertura.
//
// Si un partido tiene en un mismo tick varios eventos, se envía UN solo push
// compuesto en lugar de una ráfaga de notificaciones.
// Esto reduce el ruido brutalmente vs el flujo anterior (1 push por evento).
//
// Detección por delta vs el tick anterior (`existingLive`):
//   - Contadores que SUBEN → evento.
//   - Listas (events array) → nuevos eventos no presentes antes (por minuto+player).
//   - Si `existingLive[fid]` no existe → es la primera vez que vemos el
//     partido, no notificamos para no spamear el estado inicial.
// ────────────────────────────────────────────────────────────────────────────
function formatMinute(status) {
  const e = status?.elapsed;
  const x = status?.extra;
  if (!e) return '?';
  return x > 0 ? `${e}+${x}` : `${e}`;
}

// Etiqueta española según el detail real de API-Football.
function goalTypeLabel(scorer) {
  const t = scorer?.type;
  if (t === 'Penalty') return 'GOL DE PENALTI';
  if (t === 'Own Goal') return 'GOL EN CONTRA';
  return 'GOL';
}

function penaltyVarLabel(detail) {
  const normalized = String(detail || '').toLowerCase();
  if (normalized.includes('cancel')) return 'PENALTI ANULADO';
  if (normalized.includes('confirm')) return 'PENALTI CONFIRMADO';
  return 'REVISIÓN DE PENALTI';
}

// Key estable para deduplicar eventos en listas (VAR y penalti).
//
// BUG FIX (penaltis/cambios duplicados — confirmado 2026-05-26: el penalti de
// S. Ndlabi llegó 2 veces, como min 26 y min 27): antes la key incluía
// minute+extra. API-Football frecuentemente CORRIGE el minuto de un evento
// entre ticks (lo reporta primero en el 26 y luego lo ajusta al 27), y eso
// generaba una key distinta → el mismo evento se contaba como nuevo → push
// duplicado. La identidad real de un evento de lista es jugador+equipo+tipo
// (un jugador no hace dos sustituciones ni dos penaltis del mismo tipo en un
// partido), NO el minuto — que es un dato volátil. Quitar minute/extra de la
// key hace la dedup robusta ante esas correcciones.
function evKey(ev) {
  return `${ev.player ?? ''}|${ev.teamId ?? ''}|${ev.detail ?? ev.kind ?? ev.type ?? ''}`;
}

// Identidad de un evento VAR (no-gol). NO incluimos `player`: en eventos VAR la
// atribución de jugador oscila entre null y nombre tick a tick, y cada variante
// generaba una clave nueva → el mismo VAR se notificaba 10+ veces. Identidad
// estable = equipo + detalle normalizado (sin minuto). El "gol anulado" NO pasa
// por aquí: se deriva del descenso del marcador (ver handleGoalSide).
function varKey(v) {
  const detail = (v.detail ?? '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  return `${v.teamId ?? ''}|${detail}`;
}

// ¿El detalle de un evento VAR se refiere a un GOL (confirmado/anulado)? Esos se
// gestionan por el marcador autoritativo (subida = gol, bajada = gol anulado),
// no por el array VAR, para no duplicar ni heredar su inestabilidad de player.
function isGoalVarDetail(detail) {
  return /goal/i.test((detail ?? '').toString());
}

// ─── Deduplicación cross-tick por Redis ────────────────────────────────────
// PROBLEMA QUE RESUELVE: el mismo evento se notificaba 2-3 veces en ticks
// consecutivos de 20s. Causa: `existingLive` se lee de Redis al inicio del
// tick, pero `mergedLive` (con los contadores nuevos) se ESCRIBE de vuelta a
// Redis DESPUÉS de invocar sendBundledPushes (que es fire-and-forget). Si el
// siguiente tick de 90s arranca antes de que esa escritura se vea reflejada
// (latencia de Redis, pipelining, o porque sendBundledPushes await-ea
// subscriptions y favoritos primero), `existingLive` en el tick N+1 sigue
// mostrando los contadores viejos → mismo delta → mismo push.
//
// FIX: en lugar de confiar solo en `existingLive` para evitar repeticiones,
// marcamos en Redis con TTL=300s (3 ticks de 90s + buffer) una clave por
// EVENTO ya notificado:
//   push:sent:{fid}:goal:{side}:{N}          — gol cuando el marcador llega a N
//   push:sent:{fid}:goalcancel:{side}:{N}    — gol anulado: marcador revertido DESDE N
//   push:sent:{fid}:corner:{side}:{N}        — cada córner en su valor exacto
//   push:sent:{fid}:yellow:{side}:{N}        — amarilla por lado y valor
//   push:sent:{fid}:red:{side}:{N}
//   push:sent:{fid}:penalty:{evKey}          — penalti por (player|equipo|kind)
//   push:sent:{fid}:var:{varKey}             — VAR no-gol por (equipo|detalle)
//   push:sent:{fid}:shot:{playerKey}:{N}      — remate total acumulado
//   push:sent:{fid}:sot:{playerKey}:{N}       — remate a puerta acumulado
//   push:sent:{fid}:foul:{playerKey}:{N}      — falta cometida acumulada
//
// Antes de añadir la línea al bundle, comprobamos cada clave. Si existe →
// skip. Las claves quedan en Redis con TTL y desaparecen solas; el evento
// (que es estrictamente posterior a "ese contador en ese valor") nunca se
// repetirá dentro de esa ventana.
//
// TTL POR TIPO DE EVENTO:
//  - Eventos "de una vez" en el partido (gol, tarjeta, penalti, remate, falta,
//    VAR de penalti, gol anulado) usan 7200s (2h) para disparo único: no se
//    re-notifican aunque la API reordene/reenvíe el evento mucho después.
//  - Córner: TTL corto (300s, default). Su clave incluye el valor exacto del
//    contador monótono; cada córner nuevo es un valor nuevo que debe poder
//    notificarse en cuanto ocurra, y nunca baja (Math.max).
//  - goal y goalcancel además se LIMPIAN activamente (redisDel) cuando el
//    marcador autoritativo sube/baja, para que un gol re-anotado al mismo valor
//    y una segunda anulación de un gol distinto vuelvan a notificar.
const DEDUP_TTL_SEC = 300; // default (córner): 3 ticks de 90s + buffer
const DEDUP_TTL_BY_TYPE = {
  goal: 7200,
  goalcancel: 7200,
  yellow: 7200,
  red: 7200,
  penalty: 7200,
  var: 7200,
  shot: 7200,
  sot: 7200,
  foul: 7200,
};

function dedupKey(fid, ...parts) {
  return `push:sent:${fid}:${parts.join(':')}`;
}

// La clave tiene forma `push:sent:{fid}:{type}:...`; el tipo es el 4º segmento
// (índice 3 tras split por ':'). Mapeamos tipo → TTL; si no está en el map,
// usamos el default corto.
function ttlForKey(key) {
  const type = String(key).split(':')[3];
  return DEDUP_TTL_BY_TYPE[type] ?? DEDUP_TTL_SEC;
}

// ─── Event-log de observabilidad ───────────────────────────────────────────
// Registro persistente y auditable de CADA evento en vivo detectado, con
// timestamps reales. Resuelve la ceguera temporal del sistema anterior (logs
// console.log sin hora). Permite comparar, por evento:
//   - min        → minuto del partido en que ocurrió (lo que ve el usuario)
//   - tDetected  → hora exacta (ISO) en que el worker lo detectó del feed API
//   - tPush      → hora exacta en que se envió el push (o null si no se envió)
//   - pushResult → delivered | no-favorites | failed
//   - tShown     → hora en que el frontend lo pintó (lo rellena la telemetría
//                  del cliente vía /api/telemetry/live-shown; null si nadie lo vio)
// Guardado en Redis `eventlog:{date}` (lista JSON, TTL 48h, cap 3000). Seguro
// con concurrency=1 del worker live (no hay dos ticks simultáneos).
const EVENTLOG_TTL_SEC = 48 * 3600;
const EVENTLOG_CAP = 3000;

function detectEventType(line) {
  if (line.startsWith('⚽')) return 'goal';
  if (line.startsWith('⛔')) return 'goal_cancelled';
  if (line.startsWith('🚩')) return 'corner';
  if (line.startsWith('🟨')) return 'yellow';
  if (line.startsWith('🟥')) return 'red';
  if (line.startsWith('🎯')) return 'shot_on_target';
  if (line.startsWith('◉')) return 'shot';
  if (line.startsWith('⚠')) return 'foul';
  if (line.startsWith('🅿')) return 'penalty';
  return 'other';
}

async function appendEventLog(date, items) {
  if (!items || items.length === 0) return;
  const key = `eventlog:${date}`;
  try {
    const existing = (await redisGet(key)) || [];
    const merged = [...existing, ...items];
    const capped = merged.length > EVENTLOG_CAP ? merged.slice(-EVENTLOG_CAP) : merged;
    await redisSet(key, capped, EVENTLOG_TTL_SEC);
  } catch (e) {
    console.error('[eventlog] append:', e.message);
  }
}

async function alreadySent(key) {
  try {
    const v = await redisGet(key);
    return v !== null && v !== undefined;
  } catch {
    // Si Redis falla en la lectura, FAIL OPEN — no bloqueamos la
    // notificación. Es mejor un push duplicado ocasional que un evento
    // perdido por un transient de Redis.
    return false;
  }
}

async function markSent(key) {
  try { await redisSet(key, 1, ttlForKey(key)); } catch {}
}

// Igual que markSent pero con TTL explícito (usado por gates internos que
// necesitan una ventana distinta a la dedup de eventos).
async function markSentTTL(key, ttlSec) {
  try { await redisSet(key, 1, ttlSec); } catch {}
}

// ─── Remates y faltas con autor ───────────────────────────────────────────
// `/fixtures/events` no contiene esas acciones. `/fixtures?ids=...` sí incluye
// `events`, `statistics` y el bloque `players` con contadores individuales. Una
// sola descarga batched alimenta goleadores, córners, tarjetas, remates y faltas:
// nunca hacemos una segunda ronda de llamadas solo para actividad de jugadores.
// El snapshot vive separado del liveStats que consume la UI, evitando engordar
// los payloads del dashboard con decenas de jugadores.
const PLAYER_ACTIVITY_TTL_SEC = 4 * 3600;

function playerActivityRedisKey(fid) {
  return `live:playeractivity:${fid}`;
}

async function persistPlayerActivitySnapshot(fid, snapshot) {
  if (!snapshot?.players) return;
  try {
    await redisSet(playerActivityRedisKey(fid), snapshot, PLAYER_ACTIVITY_TTL_SEC);
  } catch (e) {
    console.error(`[live:players] no se pudo guardar baseline fid=${fid}:`, e.message);
  }
}

async function fetchDetailedLiveMatches(fixturesOrIds, label = 'live') {
  const batches = fixtureDetailBatches(fixturesOrIds);
  if (batches.length === 0) return { matches: [], apiCalls: 0, failedBatches: 0 };

  const matches = [];
  let apiCalls = 0;
  let failedBatches = 0;
  await Promise.all(batches.map(async batch => {
    apiCalls++;
    const rows = await apiFetch(`/fixtures?ids=${batch.join('-')}`);
    if (Array.isArray(rows)) matches.push(...rows);
    else failedBatches++;
  }));

  console.log(`[live:details] ${label} lotes=${batches.length} fixtures=${batches.flat().length} recibidos=${matches.length} fallidos=${failedBatches}`);
  return { matches, apiCalls, failedBatches };
}

async function buildPlayerActivityUpdates(detailedMatches) {
  const updates = new Map();
  if (!Array.isArray(detailedMatches) || detailedMatches.length === 0) return updates;

  const observedAt = new Date().toISOString();
  await Promise.all(detailedMatches.map(async match => {
    const fid = Number(match?.fixture?.id);
    if (!Number.isFinite(fid)) return;
    const extracted = extractPlayerActivity(match?.players || []);
    // Sin cobertura individual no inventamos autor ni reemplazamos baseline.
    if (extracted.length === 0) return;

    let previousSnapshot = null;
    try { previousSnapshot = await redisGet(playerActivityRedisKey(fid)); } catch {}
    const previous = Array.isArray(previousSnapshot?.players) ? previousSnapshot.players : [];
    const current = mergePlayerActivity(previous, extracted);
    const snapshot = { observedAt, players: current };

    // Primera observación = baseline silencioso: nunca enviar el acumulado del
    // partido como si acabara de ocurrir.
    if (previous.length === 0) {
      await persistPlayerActivitySnapshot(fid, snapshot);
      return;
    }

    const changes = diffPlayerActivity(previous, current);
    if (changes.length === 0) {
      await persistPlayerActivitySnapshot(fid, snapshot);
      return;
    }
    updates.set(String(fid), { snapshot, changes });
  }));

  console.log(`[live:players] fixturesDetallados=${detailedMatches.length} conCambios=${updates.size}`);
  return updates;
}

async function buildEventBundle(fid, data, prev, playerActivityUpdate = null) {
  const DP = '[live:push:diag]';
  const home = data.homeTeam?.name || '?';
  const away = data.awayTeam?.name || '?';
  const minute = formatMinute(data.status);
  const lines = []; // emoji + texto, una línea por evento
  const sentKeys = []; // claves a marcar como notificadas si el bundle se envía
  let urgent = false;
  // skipReasons: por qué un delta detectado NO terminó en línea (dedup, sin
  // jugador, etc.). Vacío + lines vacío ⇒ no hubo ningún delta (baseline==actual).
  const skipReasons = [];

  // ── SNAPSHOT DIAGNÓSTICO baseline (prev) vs actual (data) ──
  // Este log se emite por fixture/tick ANTES de cualquier comparación para
  // que la auditoría vea exactamente qué valores se están comparando. Si un
  // córner ocurre pero baseline==actual, aquí se ve que el delta nunca llegó.
  const snap = {
    goals:   { base: `${prev.goals?.home ?? 0}-${prev.goals?.away ?? 0}`,       now: `${data.goals?.home ?? 0}-${data.goals?.away ?? 0}` },
    corners: { base: `${prev.corners?.home ?? 0}-${prev.corners?.away ?? 0}`,   now: `${data.corners?.home ?? 0}-${data.corners?.away ?? 0}`, baseReal: prev.corners?.isReal ?? null, nowReal: data.corners?.isReal ?? null },
    yellow:  { base: `${prev.yellowCards?.home ?? 0}-${prev.yellowCards?.away ?? 0}`, now: `${data.yellowCards?.home ?? 0}-${data.yellowCards?.away ?? 0}` },
    red:     { base: `${prev.redCards?.home ?? 0}-${prev.redCards?.away ?? 0}`, now: `${data.redCards?.home ?? 0}-${data.redCards?.away ?? 0}` },
    pen:     { base: (prev.penaltyEvents || []).length, now: (data.penaltyEvents || []).length },
    var:     { base: (prev.varEvents || []).length, now: (data.varEvents || []).length },
    playerActivity: { changes: playerActivityUpdate?.changes?.length || 0 },
  };
  console.log(`${DP} fid=${fid} ${home}-${away} min=${minute}' | ` +
    `goals base=${snap.goals.base} now=${snap.goals.now} | ` +
    `corners base=${snap.corners.base}(real=${snap.corners.baseReal}) now=${snap.corners.now}(real=${snap.corners.nowReal}) | ` +
    `yellow base=${snap.yellow.base} now=${snap.yellow.now} | ` +
    `red base=${snap.red.base} now=${snap.red.now} | ` +
    `pen base=${snap.pen.base} now=${snap.pen.now} | ` +
    `var base=${snap.var.base} now=${snap.var.now} | ` +
    `actividadJugador cambios=${snap.playerActivity.changes}`);

  // REGLA GLOBAL DE CALIDAD DE NOTIFICACIONES:
  // Solo emitimos una línea si los DATOS REALES están presentes (jugador,
  // equipo, detalle concreto). Eventos con info incompleta o derivados solo
  // de contadores agregados (como offsides, que vienen del stat agregado por
  // minuto sin jugador) NO se notifican. Mejor 1 push correcto que 5 ruidosos.

  // ── Goles ── (info real: scorer + detail de cómo fue el gol)
  // goalScorers viene del array events de API-Football (type='Goal').
  // detail puede ser: 'Normal Goal', 'Penalty', 'Own Goal'. Lo expone.
  const pHG = prev.goals?.home ?? 0, pAG = prev.goals?.away ?? 0;
  const nHG = data.goals?.home ?? 0, nAG = data.goals?.away ?? 0;
  const scoreLabel = `${nHG}–${nAG}`;

  // Maneja un lado del marcador autoritativo (match.goals):
  //  · SUBE (gol) → notifica "⚽" (dedup por valor goal:{side}:{N}). Antes de
  //    notificar, limpia cualquier goalcancel:{side}:{N} pendiente: si este
  //    valor se anuló antes y ahora se re-anota, una FUTURA anulación debe poder
  //    volver a avisar.
  //  · BAJA (gol anulado por VAR/corrección) → notifica "⛔ GOL ANULADO" UNA vez
  //    (dedup goalcancel:{side}:{valor del que se revirtió}). Una segunda
  //    anulación de un gol distinto revierte otro valor → otra clave → vuelve a
  //    notificar. Además limpia goal:{side}:{v} de los valores revertidos
  //    (Tipo A) para que re-anotarlos cuente como gol nuevo.
  // El marcador mostrado en cada línea es SIEMPRE el actual (nHG-nAG).
  async function handleGoalSide(side, teamId, teamLabel, prevG, nowG) {
    if (nowG > prevG) {
      await redisDel(dedupKey(fid, 'goalcancel', side, nowG));
      const k = dedupKey(fid, 'goal', side, nowG);
      if (!(await alreadySent(k))) {
        // ÚLTIMO gol del equipo correcto (no slice(-1) ciego, que podía dar el
        // del otro equipo si la API los devuelve mezclados).
        const last = (data.goalScorers || [])
          .filter(g => g.teamId === teamId || g.teamName === teamLabel)
          .slice(-1)[0];
        const who = last?.player ? ` · ${last.player}` : '';
        const assist = last?.assist ? ` · Asist. ${last.assist}` : '';
        lines.push(`⚽ ${goalTypeLabel(last)}${who} · ${teamLabel}${assist} · ${scoreLabel}`);
        sentKeys.push(k);
        urgent = true;
        console.log(`${DP} fid=${fid} GOL ${side} delta ${prevG}→${nowG} ⇒ línea añadida`);
      } else {
        skipReasons.push(`goal-${side}(${nowG}):dedup-ya-enviado`);
        console.log(`${DP} fid=${fid} GOL ${side} delta ${prevG}→${nowG} pero dedup key ya marcada ⇒ SKIP`);
      }
    } else if (nowG < prevG) {
      // Tipo A: liberar las claves de los valores revertidos (re-anotar re-notifica).
      for (let v = nowG + 1; v <= prevG; v++) {
        await redisDel(dedupKey(fid, 'goal', side, v));
      }
      const k = dedupKey(fid, 'goalcancel', side, prevG);
      if (!(await alreadySent(k))) {
        const cancelled = (data.varEvents || [])
          .filter(v => isGoalVarDetail(v.detail) && (v.teamId === teamId || v.teamName === teamLabel))
          .slice(-1)[0];
        const who = cancelled?.player ? ` · ${cancelled.player}` : '';
        lines.push(`⛔ GOL ANULADO${who} · ${teamLabel} · ${scoreLabel}`);
        sentKeys.push(k);
        urgent = true;
        console.log(`${DP} fid=${fid} GOL ANULADO ${side} marcador ${prevG}→${nowG} ⇒ línea añadida (clave goalcancel:${side}:${prevG})`);
      } else {
        skipReasons.push(`goalcancel-${side}(${prevG}):dedup-ya-enviado`);
        console.log(`${DP} fid=${fid} GOL ANULADO ${side} ${prevG}→${nowG} pero dedup key ya marcada ⇒ SKIP`);
      }
    }
  }
  await handleGoalSide('home', data.homeTeam?.id, home, pHG, nHG);
  await handleGoalSide('away', data.awayTeam?.id, away, pAG, nAG);

  // ── Córners ── REAL: pasó un córner, sabemos qué equipo lo lanza.
  // API-Football NO expone córners como events con jugador (solo el contador
  // en stats por equipo). Por tanto no podemos dar el lanzador, pero la
  // información de "córner para X" SÍ es real (no es una estadística
  // ambigua como offsides — un córner se pita o no se pita).
  const pHC = prev.corners?.home ?? 0, pAC = prev.corners?.away ?? 0;
  // Córners monótonos por-lado: el "now" de cada lado es el máximo entre el
  // acumulado (prev) y el del tick. Así un lado nulo (API lo trajo como 0)
  // nunca baja el contador ni dispara falsos retrocesos, y un córner nuevo
  // (cur>prev) sí dispara delta. Cubre tanto el tick entero no-real como el
  // caso de un solo lado null (el bug 8-1 → 8-0).
  const nHC = Math.max(pHC, data.corners?.home ?? 0);
  const nAC = Math.max(pAC, data.corners?.away ?? 0);
  if (nHC > pHC) {
    const k = dedupKey(fid, 'corner', 'home', nHC);
    if (!(await alreadySent(k))) {
      lines.push(`🚩 CÓRNER · ${home} · ${nHC}–${nAC}`);
      sentKeys.push(k);
      console.log(`${DP} fid=${fid} CORNER home delta ${pHC}→${nHC} ⇒ línea añadida`);
    } else {
      skipReasons.push(`corner-home(${nHC}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} CORNER home delta ${pHC}→${nHC} pero dedup key ya marcada (${k}) ⇒ SKIP`);
    }
  } else {
    console.log(`${DP} fid=${fid} CORNER home sin delta (base=${pHC} now=${nHC})`);
  }
  if (nAC > pAC) {
    const k = dedupKey(fid, 'corner', 'away', nAC);
    if (!(await alreadySent(k))) {
      lines.push(`🚩 CÓRNER · ${away} · ${nHC}–${nAC}`);
      sentKeys.push(k);
      console.log(`${DP} fid=${fid} CORNER away delta ${pAC}→${nAC} ⇒ línea añadida`);
    } else {
      skipReasons.push(`corner-away(${nAC}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} CORNER away delta ${pAC}→${nAC} pero dedup key ya marcada (${k}) ⇒ SKIP`);
    }
  } else {
    console.log(`${DP} fid=${fid} CORNER away sin delta (base=${pAC} now=${nAC})`);
  }

  // ── Amarillas ── REAL: tarjeta pitada con jugador (viene del array events).
  // SI no encontramos al jugador en cardEvents, NO notificamos — preferimos
  // saltar antes que mostrar "🟨 Equipo" sin más (sería ruido).
  const pHY = prev.yellowCards?.home ?? 0, pAY = prev.yellowCards?.away ?? 0;
  const nHY = data.yellowCards?.home ?? 0, nAY = data.yellowCards?.away ?? 0;
  if (nHY > pHY) {
    const k = dedupKey(fid, 'yellow', 'home', nHY);
    if (!(await alreadySent(k))) {
      // BUG FIX (amarillas no disparaban): antes, si no encontrábamos al
      // jugador en cardEvents (típico en ligas sin `events` inline), se hacía
      // SKIP y la amarilla nunca se notificaba. Ahora notificamos igualmente
      // con el equipo (fallback solo-equipo, consistente con las rojas). Si
      // hay jugador lo añadimos; si no, "🟨 Amarilla · Equipo".
      const lastCard = (data.cardEvents || [])
        .filter(e => e.type === 'Yellow Card' && e.teamName === home && e.player)
        .slice(-1)[0];
      const who = lastCard?.player || 'Jugador no informado';
      lines.push(`🟨 AMARILLA · ${who} · ${home} · ${nHY}–${nAY}`);
      sentKeys.push(k);
      console.log(`${DP} fid=${fid} AMARILLA home delta ${pHY}→${nHY} jugador=${lastCard?.player || 'desconocido(solo-equipo)'} ⇒ línea añadida`);
    } else {
      skipReasons.push(`yellow-home(${nHY}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} AMARILLA home delta ${pHY}→${nHY} pero dedup key ya marcada ⇒ SKIP`);
    }
  }
  if (nAY > pAY) {
    const k = dedupKey(fid, 'yellow', 'away', nAY);
    if (!(await alreadySent(k))) {
      const lastCard = (data.cardEvents || [])
        .filter(e => e.type === 'Yellow Card' && e.teamName === away && e.player)
        .slice(-1)[0];
      const who = lastCard?.player || 'Jugador no informado';
      lines.push(`🟨 AMARILLA · ${who} · ${away} · ${nHY}–${nAY}`);
      sentKeys.push(k);
      console.log(`${DP} fid=${fid} AMARILLA away delta ${pAY}→${nAY} jugador=${lastCard?.player || 'desconocido(solo-equipo)'} ⇒ línea añadida`);
    } else {
      skipReasons.push(`yellow-away(${nAY}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} AMARILLA away delta ${pAY}→${nAY} pero dedup key ya marcada ⇒ SKIP`);
    }
  }

  // ── Rojas / expulsiones ── REAL: viene del array events con jugador.
  // Las rojas son críticas — si por algún motivo el array no tiene player
  // (raro, pero posible en ligas exóticas), SÍ notificamos sin nombre porque
  // una expulsión es relevante aunque no sepamos quién. Es la excepción al
  // criterio de cards/offside.
  const pHR = prev.redCards?.home ?? 0, pAR = prev.redCards?.away ?? 0;
  const nHR = data.redCards?.home ?? 0, nAR = data.redCards?.away ?? 0;
  if (nHR > pHR) {
    const k = dedupKey(fid, 'red', 'home', nHR);
    if (!(await alreadySent(k))) {
      const lastCard = (data.cardEvents || [])
        .filter(e => (e.type === 'Red Card' || e.type === 'Second Yellow card') && e.teamName === home)
        .slice(-1)[0];
      const who = lastCard?.player || 'Jugador no informado';
      lines.push(`🟥 EXPULSIÓN · ${who} · ${home} · ${nHR}–${nAR}`);
      sentKeys.push(k);
      urgent = true;
      console.log(`${DP} fid=${fid} ROJA home delta ${pHR}→${nHR} jugador=${lastCard?.player || 'desconocido'} ⇒ línea añadida`);
    } else {
      skipReasons.push(`red-home(${nHR}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} ROJA home delta ${pHR}→${nHR} pero dedup key ya marcada ⇒ SKIP`);
    }
  }
  if (nAR > pAR) {
    const k = dedupKey(fid, 'red', 'away', nAR);
    if (!(await alreadySent(k))) {
      const lastCard = (data.cardEvents || [])
        .filter(e => (e.type === 'Red Card' || e.type === 'Second Yellow card') && e.teamName === away)
        .slice(-1)[0];
      const who = lastCard?.player || 'Jugador no informado';
      lines.push(`🟥 EXPULSIÓN · ${who} · ${away} · ${nHR}–${nAR}`);
      sentKeys.push(k);
      urgent = true;
      console.log(`${DP} fid=${fid} ROJA away delta ${pAR}→${nAR} jugador=${lastCard?.player || 'desconocido'} ⇒ línea añadida`);
    } else {
      skipReasons.push(`red-away(${nAR}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} ROJA away delta ${pAR}→${nAR} pero dedup key ya marcada ⇒ SKIP`);
    }
  }

  // ── Offsides ── ELIMINADO (commit P3-quality):
  // API-Football solo expone offsides como contador agregado en stats
  // (sin jugador, sin minuto exacto, sin acción específica). El push
  // "🚫 Offside · Equipo" no aporta información real al usuario. Se mantiene
  // el contador en data.offsides para el dashboard, pero NO se notifica.

  // ── Sustituciones ── NO SE NOTIFICAN.
  // Se mantienen en el snapshot para usos internos, pero el usuario pidió
  // eliminar completamente este ruido del canal push.

  // ── Remates / remates a puerta / faltas ──
  // Deltas por jugador entre snapshots reales de API-Football. Si la liga no
  // tiene cobertura de `players`, playerActivityUpdate es null y no se emite
  // nada. El baseline se confirma solo después de una entrega (o cuando nadie
  // sigue el partido), preservando el reintento si el proveedor push falla.
  let activityLines = 0;
  for (const change of (playerActivityUpdate?.changes || [])) {
    const dedupType = change.type === 'shot_on_target' ? 'sot' : change.type;
    const k = dedupKey(fid, dedupType, change.playerKey, change.counter);
    if (await alreadySent(k)) {
      skipReasons.push(`${dedupType}:${change.player}:dedup-ya-enviado`);
      continue;
    }
    const times = change.count > 1 ? ` ×${change.count}` : '';
    if (change.type === 'shot_on_target') {
      lines.push(`🎯 REMATE A PUERTA · ${change.player} · ${change.teamName}${times}`);
    } else if (change.type === 'shot') {
      lines.push(`◉ REMATE · ${change.player} · ${change.teamName}${times}`);
    } else if (change.type === 'foul') {
      lines.push(`⚠ FALTA COMETIDA · ${change.player} · ${change.teamName}${times}`);
    } else {
      continue;
    }
    sentKeys.push(k);
    activityLines++;
  }

  // Si las claves ya estaban marcadas, ese delta fue entregado antes y solo
  // faltaba avanzar el baseline (p. ej. reinicio entre dos escrituras).
  if (playerActivityUpdate?.snapshot && activityLines === 0) {
    await persistPlayerActivitySnapshot(fid, playerActivityUpdate.snapshot);
  }

  // ── Penaltis (lista — missed / awarded) ──
  // Un penalti CONVERTIDO (kind='scored') NO se notifica aquí: ya llega como
  // "⚽ … (de penal)" en el momento exacto del gol (vía delta de marcador, sin
  // lag). Notificarlo otra vez duplicaba y llegaba tarde (el detail del evento
  // de penalti llega con retraso respecto al marcador). Aquí solo notificamos
  // los penaltis FALLADOS (sin gol, única forma de enterarse) y, si la API lo
  // expone, los señalados. Así el usuario nunca pierde un penalti: gol→lo ve
  // como gol de penal; fallado→push de penalti fallado.
  const prevPenKeys = new Set((prev.penaltyEvents || []).map(evKey));
  const newPens = (data.penaltyEvents || []).filter(p => !prevPenKeys.has(evKey(p)));
  if (newPens.length > 0) console.log(`${DP} fid=${fid} PENALTI ${newPens.length} evento(s) nuevo(s) vs baseline`);
  for (const p of newPens) {
    if (p.kind === 'scored') {
      skipReasons.push('penalty:scored→ya va como ⚽ (de penal)');
      console.log(`${DP} fid=${fid} PENALTI convertido ${p.teamName} ⇒ NO push aparte (va como gol de penal)`);
      continue;
    }
    const k = dedupKey(fid, 'penalty', evKey(p));
    if (await alreadySent(k)) {
      skipReasons.push(`penalty(${p.kind}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} PENALTI ${p.kind} dedup ya marcada ⇒ SKIP`);
      continue;
    }
    const verb = p.kind === 'missed' ? 'PENALTI FALLADO' : 'PENALTI SEÑALADO';
    lines.push(`🅿️ ${verb}${p.player ? ` · ${p.player}` : ''} · ${p.teamName || 'Equipo no informado'}`);
    sentKeys.push(k);
    urgent = true;
    console.log(`${DP} fid=${fid} PENALTI ${verb} ${p.teamName} ⇒ línea añadida`);
  }

  // ── VAR ── Solo decisiones de PENALTI.
  // El "gol anulado" NO se emite aquí: se deriva del DESCENSO del marcador
  // autoritativo (handleGoalSide). Esto evita el bug del mismo gol anulado
  // notificado 10+ veces por la inestabilidad de `player` en el evento VAR.
  // Revisiones de tarjetas u otras decisiones dejan de generar push. El gol
  // anulado sigue derivándose del marcador autoritativo en handleGoalSide.
  const isPenaltyVar = v => /penalty|penalti/i.test(String(v?.detail || ''));
  const prevVarKeys = new Set((prev.varEvents || [])
    .filter(v => !isGoalVarDetail(v.detail) && isPenaltyVar(v))
    .map(varKey));
  const newVars = (data.varEvents || [])
    .filter(v => !isGoalVarDetail(v.detail) && isPenaltyVar(v) && !prevVarKeys.has(varKey(v)));
  if (newVars.length > 0) console.log(`${DP} fid=${fid} VAR-PENALTI ${newVars.length} evento(s) nuevo(s) vs baseline`);
  for (const v of newVars) {
    const k = dedupKey(fid, 'var', varKey(v));
    if (await alreadySent(k)) {
      skipReasons.push(`var:dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} VAR ${v.detail} dedup ya marcada ⇒ SKIP`);
      continue;
    }
    const det = penaltyVarLabel(v.detail);
    lines.push(`🅿️ ${det}${v.player ? ` · ${v.player}` : ''} · ${v.teamName || 'Equipo no informado'}`);
    sentKeys.push(k);
    urgent = true;
    console.log(`${DP} fid=${fid} VAR-PENALTI ${det} ${v.teamName} ⇒ línea añadida`);
  }

  if (lines.length === 0) {
    // RESUMEN del por qué NO se generó bundle para este fixture: o no hubo
    // ningún delta (baseline==actual en todo) o todos los deltas fueron
    // bloqueados (dedup / sin jugador / incompletos). skipReasons lo dice.
    const motivo = skipReasons.length > 0
      ? `deltas detectados pero TODOS bloqueados: [${skipReasons.join(', ')}]`
      : 'sin deltas — baseline == actual en todos los contadores/listas';
    console.log(`${DP} fid=${fid} ⇒ NO BUNDLE · ${motivo}`);
    return null;
  }
  console.log(`${DP} fid=${fid} ⇒ BUNDLE con ${lines.length} línea(s)${skipReasons.length ? ` (${skipReasons.length} skip: [${skipReasons.join(', ')}])` : ''}`);

  // Título compacto y profesional: minuto + partido + marcador.
  // El "from cfanalisis.com" que muestra Chrome debajo es el origen que el
  // navegador añade automáticamente y NO se puede quitar por código.
  // Body: una línea por evento. No truncamos silenciosamente los nombres; el
  // bundle de un minuto sigue muy por debajo del límite Web Push de 4 KB.
  const title = `${minute}′ · ${home} ${scoreLabel} ${away}`;
  const body = lines.join('\n');
  // Tag estable por fixture+minuto+nEventos para que múltiples ticks no
  // sobrescriban notificaciones distintas. FCM reemplaza notifs con mismo tag.
  const tag = `live-${fid}-${minute}-${lines.length}`;
  // Event-log: una entrada estructurada por línea/evento detectado, con la
  // hora exacta de detección. El caller (sendBundledPushes) le añade tPush +
  // pushResult tras intentar el envío y lo persiste en Redis.
  const tDetected = new Date().toISOString();
  const events = lines.map((line) => ({
    fid: Number(fid), min: minute, type: detectEventType(line),
    detail: line, home, away, score: `${nHG}-${nAG}`, tDetected,
  }));
  // sentKeys: el caller marca cada una en Redis DESPUÉS de enviar el push
  // (ver sendBundledPushes), no aquí. Si marcamos antes de enviar y el envío
  // falla, perdemos el evento para siempre. Marcar después es at-least-once.
  return {
    fixtureId: Number(fid), title, body, tag, urgent, sentKeys, events,
    activitySnapshot: activityLines > 0 ? playerActivityUpdate?.snapshot || null : null,
  };
}

async function sendBundledPushes(liveDetailsMap, existingLive, today, playerActivityUpdates = new Map()) {
  const LP = '[live:push]';
  // Eventos a persistir en el event-log (con tPush + resultado por bundle).
  const eventLogItems = [];
  // 1. Construir bundles por fixture (solo cuando hay deltas y baseline previa).
  // buildEventBundle es ahora async porque consulta dedup keys en Redis.
  const fids = Object.keys(liveDetailsMap);
  const withBaseline = fids.filter(fid => existingLive[fid]).length;
  const bundles = [];
  for (const [fid, data] of Object.entries(liveDetailsMap)) {
    const prev = existingLive[fid];
    if (!prev) continue; // sin baseline → no notificamos el estado inicial
    const bundle = await buildEventBundle(fid, data, prev, playerActivityUpdates.get(String(fid)) || null);
    if (bundle) bundles.push(bundle);
  }
  console.log(`${LP} tick: fixtures=${fids.length} conBaseline=${withBaseline} bundles=${bundles.length}`);
  if (bundles.length === 0) return;
  for (const b of bundles) {
    console.log(`${LP} bundle fid=${b.fixtureId} "${b.title}" lineas=[${b.body.replace(/\n/g, ' | ')}]`);
  }

  // 2. Cargar suscripciones + favoritos por usuario una sola vez
  const { data: subs, error: subsErr } = await supabaseAdmin
    .from('push_subscriptions')
    .select('user_id, subscription');
  if (subsErr) { console.error(`${LP} error leyendo push_subscriptions:`, subsErr.message || subsErr); return; }
  console.log(`${LP} suscripciones en BD: ${subs?.length || 0}`);
  if (!subs?.length) {
    // No hay nadie a quien notificar pero el evento ocurrió → marcamos las
    // dedup keys igual para que el siguiente tick no vuelva a construir el
    // mismo bundle inútilmente (evento ya "vivido").
    for (const b of bundles) {
      if (Array.isArray(b.sentKeys)) {
        await Promise.all(b.sentKeys.map(k => markSent(k)));
      }
      if (b.activitySnapshot) {
        await persistPlayerActivitySnapshot(b.fixtureId, b.activitySnapshot);
      }
      for (const ev of (b.events || [])) {
        eventLogItems.push({ ...ev, tPush: null, pushResult: 'no-subscribers', subsTargeted: 0 });
      }
    }
    await appendEventLog(today, eventLogItems);
    return;
  }

  // W1 FIX: antes 1 query de favoritos POR usuario (N+1, cada 20s). Ahora UNA
  // sola query con IN y agrupación en memoria.
  const favoritesByUser = {};
  const userIds = [...new Set(subs.map(r => r.user_id).filter(Boolean))];
  for (const uid of userIds) favoritesByUser[uid] = new Set();
  if (userIds.length > 0) {
    const { data: favRows } = await supabaseAdmin
      .from('user_favorites')
      .select('user_id, fixture_id')
      .in('user_id', userIds);
    for (const r of (favRows || [])) {
      (favoritesByUser[r.user_id] ||= new Set()).add(Number(r.fixture_id));
    }
  }

  // 3. Enviar — recolectar endpoints expirados para purga al final
  const expiredByUser = {};
  let attempted = 0, delivered = 0, failed = 0, expiredN = 0, skippedNoFav = 0;
  for (const bundle of bundles) {
    // Track si ALGÚN intento tuvo éxito para este bundle. Solo marcamos las
    // dedup keys como "enviadas" si al menos uno se entregó OK — así, si todos
    // los pushes fallan por un error transitorio del push server, el siguiente
    // tick puede reintentar el mismo evento (at-least-once).
    let bundleHadDelivery = false;
    let bundleHadSubscriberInFav = false;

    // Cuántos suscriptores tienen ESTE fixture en favoritos — si es 0, el push
    // nunca se intenta (todos caen en el guard de favoritos). Lo logueamos para
    // distinguir "nadie lo tiene en favoritos" de "lo tienen pero falló el envío".
    const subsWithThisFav = subs.filter(r => (favoritesByUser[r.user_id] || new Set()).has(bundle.fixtureId)).length;
    console.log(`${LP} bundle fid=${bundle.fixtureId} → favoritos: ${subsWithThisFav}/${subs.length} suscriptores`);

    await Promise.allSettled(subs.map(async (row) => {
      const favs = favoritesByUser[row.user_id] || new Set();
      if (!favs.has(bundle.fixtureId)) { skippedNoFav++; return; }
      bundleHadSubscriberInFav = true;

      const deviceSubs = toSubArray(row.subscription);
      await Promise.allSettled(deviceSubs.map(async (sub) => {
        if (!sub?.endpoint) return;
        attempted++;
        // Todos los eventos en vivo van con urgency 'high' (apns-priority 10):
        // cada evento es time-sensitive. Con 'normal' iOS los retenía y los
        // entregaba tarde o en lote ("en fila de golpe").
        const result = await sendPushNotification(
          sub,
          {
            title: bundle.title,
            body: bundle.body,
            tag: bundle.tag,
            url: '/dashboard',
            timestamp: new Date().toISOString(),
          },
          { urgency: 'high' },
        );
        if (result === true) { delivered++; bundleHadDelivery = true; }
        else if (result === 'expired') {
          expiredN++;
          if (!expiredByUser[row.user_id]) expiredByUser[row.user_id] = new Set();
          expiredByUser[row.user_id].add(sub.endpoint);
        } else failed++;
      }));
    }));

    // Marcar dedup keys: si hubo entrega exitosa, evidente. Si NO había
    // ningún suscriptor con este fixture en favoritos, también las marcamos
    // — el evento "ocurrió" y no hay nadie esperando, así que reintentar en
    // los próximos ticks tampoco serviría de nada. Solo se queda SIN marcar
    // el caso donde había favoritos pero todos los envíos fallaron (push
    // server caído / red transitoria) → el siguiente tick reintenta.
    const shouldMark = bundleHadDelivery || !bundleHadSubscriberInFav;
    if (shouldMark && Array.isArray(bundle.sentKeys) && bundle.sentKeys.length > 0) {
      await Promise.all(bundle.sentKeys.map(k => markSent(k)));
      const ttlDetalle = bundle.sentKeys.map(k => `${k.split(':').slice(3).join(':')}=${ttlForKey(k)}s`).join(', ');
      console.log(`${LP} dedup marcadas ${bundle.sentKeys.length} keys fid=${bundle.fixtureId} → ${ttlDetalle}`);
    } else if (!shouldMark) {
      console.log(`${LP} dedup NO marcadas fid=${bundle.fixtureId} — todos los envíos fallaron, reintentará en próximo tick`);
    }
    if (shouldMark && bundle.activitySnapshot) {
      await persistPlayerActivitySnapshot(bundle.fixtureId, bundle.activitySnapshot);
    }

    // Event-log: registrar cada evento de este bundle con su resultado de push.
    //   delivered     → al menos un dispositivo recibió el push
    //   no-favorites  → nadie tenía este fixture en favoritos (no se intentó)
    //   failed        → había favoritos pero todos los envíos fallaron
    const pushResult = bundleHadDelivery ? 'delivered'
      : (bundleHadSubscriberInFav ? 'failed' : 'no-favorites');
    const tPush = bundleHadDelivery ? new Date().toISOString() : null;
    for (const ev of (bundle.events || [])) {
      eventLogItems.push({ ...ev, tPush, pushResult, subsTargeted: subsWithThisFav });
    }
  }

  // Persistir el event-log del tick (tras procesar todos los bundles).
  await appendEventLog(today, eventLogItems);
  console.log(`${LP} resumen: intentos=${attempted} ok=${delivered} fallo=${failed} expirados=${expiredN} sinFav(skip)=${skippedNoFav}`);

  // 4. Purga atómica de endpoints expirados
  const usersWithExpired = Object.keys(expiredByUser);
  if (usersWithExpired.length === 0) return;

  await Promise.allSettled(usersWithExpired.map(async (userId) => {
    try {
      const expiredEndpoints = expiredByUser[userId];
      const { data: row } = await supabaseAdmin
        .from('push_subscriptions')
        .select('subscription')
        .eq('user_id', userId)
        .maybeSingle();
      if (!row) return;

      const remaining = toSubArray(row.subscription).filter(s => !expiredEndpoints.has(s?.endpoint));

      if (remaining.length === 0) {
        await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', userId);
      } else {
        await supabaseAdmin.from('push_subscriptions').update({ subscription: remaining }).eq('user_id', userId);
      }
    } catch (e) {
      console.error('[push:purge-expired]', userId, e.message);
    }
  }));
}

// ── Snapshot de medio tiempo (1ª parte) → raw_api_payloads ───────────────────
// API-Football NUNCA expone córners/tiros/faltas/offsides como eventos con
// minuto, solo como contador agregado. En el tick de HT ese contador ES el
// total de la 1ª parte → lo persistimos durable (endpoint='fixtures/halfstats')
// para alimentar los mercados POR MITAD del motor de contexto. Idempotente:
// cada tick de HT reescribe el mismo firstHalf (merge jsonb ||). Fire-and-forget.
// Solo se guarda el valor de un stat si es REAL este tick (isReal) — un 0 no
// fiable se guarda como null para no contaminar la frecuencia con ceros falsos.
async function persistHalfStatsSnapshot(match, data) {
  try {
    const fid = match.fixture?.id;
    if (!fid) return;
    const realOrNull = (s) => (s && s.isReal) ? { home: s.home, away: s.away, total: s.total } : null;
    const firstHalf = {
      goals: { home: match.goals?.home ?? null, away: match.goals?.away ?? null,
               total: (match.goals?.home ?? 0) + (match.goals?.away ?? 0) },
      corners:  realOrNull(data.corners),
      shots:    realOrNull(data.shots),
      sot:      realOrNull(data.sot),
      fouls:    realOrNull(data.fouls),
      offsides: realOrNull(data.offsides),
      cards: data.yellowCards?.isReal && data.redCards?.isReal
        ? {
            home: data.yellowCards.home + data.redCards.home,
            away: data.yellowCards.away + data.redCards.away,
            total: data.yellowCards.total + data.redCards.total,
          }
        : null,
    };
    const payload = {
      fixtureId: fid,
      leagueId: match.league?.id ?? null,
      season: match.league?.season ?? null,
      teams: { home: match.teams?.home?.id ?? null, away: match.teams?.away?.id ?? null },
      firstHalf,
      capturedAt: new Date().toISOString(),
      capturedAtMinute: match.fixture?.status?.elapsed ?? null,
    };
    // El snapshot relacionado nunca debe quedar huérfano. `match` ya es el
    // fixture real del feed live, por lo que persistimos también su crudo base
    // sin gastar otra llamada. Un FT/AET/PEN ya guardado jamás se degrada con
    // una versión HT tardía.
    await pgQuery(
      `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
       VALUES ('fixtures','fixture',$1,$2,'',$3::jsonb,NOW())
       ON CONFLICT (endpoint, ref_id, sub_key) DO UPDATE
       SET payload=EXCLUDED.payload,season=EXCLUDED.season,fetched_at=NOW()
       WHERE COALESCE(raw_api_payloads.payload#>>'{fixture,status,short}','')
             NOT IN ('FT','AET','PEN')`,
      [fid, payload.season, JSON.stringify(match)]);
    await pgQuery(
      `INSERT INTO raw_api_payloads (endpoint, ref_type, ref_id, season, sub_key, payload, fetched_at)
       VALUES ('fixtures/halfstats','fixture',$1,$2,'',$3::jsonb,NOW())
       ON CONFLICT (endpoint, ref_id, sub_key)
       DO UPDATE SET payload = raw_api_payloads.payload || EXCLUDED.payload,
                     season = EXCLUDED.season, fetched_at = NOW()`,
      [fid, payload.season, JSON.stringify(payload)]);
    console.log(`[live:halfstats] HT fid=${fid} 1ªP corners=${firstHalf.corners?.total ?? 'n/a'} shots=${firstHalf.shots?.total ?? 'n/a'} fouls=${firstHalf.fouls?.total ?? 'n/a'} offsides=${firstHalf.offsides?.total ?? 'n/a'} goals=${firstHalf.goals.total}`);
  } catch (e) {
    console.error('[live:halfstats] HT snapshot:', e.message);
  }
}

// ── Red de seguridad: datos REALES de partidos vencidos / sin confirmar ─────
// Corre SIEMPRE (antes del window-skip), sobre HOY y AYER. Dos casos:
//   1) LIVE vencido (en liveStats — datos frescos <2h): expectedEnd+10min pasó,
//      o sin schedule >40min sin tocarse → el tick se saltó / se perdió su FT /
//      cruzó medianoche. Hay que reconciliarlo contra el proveedor.
//   2) FT o NS VENCIDO sin confirmar (en fixtures:{d} — el marcador que SE
//      MUESTRA, TTL 26h, sobrevive al liveStats de 2h): el feed pudo haberse
//      caído y el cache conservar NS aunque el partido ya terminara.
//
// Pedimos /fixtures?ids=... en lotes (throttle 2min/fid; cap por tick) y escribimos
// marcador/córners/goleadores REALES en liveStats + fixtures:{d} + fixtureStats,
// sobrescribiendo el entry AUNQUE ya esté FT (ese es el punto del caso 2). Un set
// de confirmados por fecha (live:rf:{d}) evita re-consultar cada FT más de una vez.
// El escaneo de fixtures:{d} (blob grande) va gateado a ~3min para no leerlo cada tick.
const FORCE_FINISH_GRACE_MS  = 10 * 60 * 1000;  // overdue vs expectedEnd del schedule
const FORCE_FINISH_STALE_MS  = 40 * 60 * 1000;  // sin schedule: tiempo sin actualizarse
const RECONCILE_MAX_AGE_MS   = 48 * 3600 * 1000; // hoy+ayer: cubre caídas largas y cruces de zona
const MAX_RECONCILE_PER_TICK = 500;              // 25 lotes; cubre jornadas de 300-400 en un ciclo
const FT_RECONCILE_EVERY_MS  = 3 * 60 * 1000;    // escaneo de fixtures:{d} cada ~3min
const TERMINAL_STATUSES = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP']);
const PENDING_STATUSES = new Set(['NS', 'TBD']);
async function forceFinishOverdueLive(allKickoffs, now, dates) {
  const eeByFid = new Map(
    (allKickoffs || []).map(m => [Number(m.fixtureId), Number(m.expectedEnd)]));
  const finished = [];
  let apiCalls = 0;

  for (const d of dates) {
    let ls; try { ls = await redisGet(KEYS.liveStats(d)); } catch { ls = null; }
    let hasLs = ls && typeof ls === 'object';

    // (1) LIVE vencidos en liveStats.
    const liveOverdue = [];
    if (hasLs) {
      for (const [fid, m] of Object.entries(ls)) {
        if (!m || !LIVE_STATUSES.includes(m.status?.short)) continue;
        const ee = eeByFid.get(Number(fid));
        const lt = m.updatedAt ? Date.parse(m.updatedAt) : 0;
        if ((Number.isFinite(ee) && now > ee + FORCE_FINISH_GRACE_MS) ||
            (!Number.isFinite(ee) && lt && now - lt > FORCE_FINISH_STALE_MS)) liveOverdue.push({ fid: Number(fid), ee });
      }
    }

    // (2) FT o NS vencido sin confirmar en fixtures:{d} (gateado a ~3min).
    let fx = null, rfSet = null;
    const cachedTargets = [];
    const gateKey = `live:ftrecon:${d}`;
    if (!(await alreadySent(gateKey))) {
      await markSentTTL(gateKey, Math.round(FT_RECONCILE_EVERY_MS / 1000));
      try { fx = await redisGet(KEYS.fixtures(d)); } catch { fx = null; }
      if (Array.isArray(fx) && fx.length > 0) {
        rfSet = (await redisGet(`live:rf:${d}`)) || {};
        for (const f of fx) {
          const fid = f.fixture?.id;
          if (!fid) continue;
          const short = f.fixture?.status?.short;
          const kickoff = f.fixture?.date ? new Date(f.fixture.date).getTime() : 0;
          const expectedEnd = eeByFid.get(Number(fid));
          const kind = cachedReconciliationKind({
            status: short,
            kickoff,
            expectedEnd,
            now,
            graceMs: FORCE_FINISH_GRACE_MS,
          });
          if (!kind) continue;
          if (rfSet[fid]) continue; // ya confirmado contra la API
          if (kickoff && now - kickoff > RECONCILE_MAX_AGE_MS) continue; // solo recientes
          cachedTargets.push({ fid: Number(fid), kind });
        }
      }
    }

    // Cursor circular: si una caída deja cientos de NS, ningún fixture sin
    // respuesta puede monopolizar para siempre los primeros 60 puestos.
    let selectedCachedTargets = cachedTargets;
    if (cachedTargets.length > MAX_RECONCILE_PER_TICK) {
      const cursorKey = `live:reconcursor:${d}`;
      const storedCursor = Number(await redisGet(cursorKey)) || 0;
      const start = storedCursor % cachedTargets.length;
      selectedCachedTargets = [];
      for (let i = 0; i < MAX_RECONCILE_PER_TICK; i++) {
        selectedCachedTargets.push(cachedTargets[(start + i) % cachedTargets.length]);
      }
      await redisSet(
        cursorKey,
        (start + MAX_RECONCILE_PER_TICK) % cachedTargets.length,
        48 * 3600,
      ).catch(() => {});
    }

    const targetMap = new Map([
      ...liveOverdue.map(x => ({ ...x, kind: 'live' })),
      ...selectedCachedTargets.map(x => ({ ...x, ee: eeByFid.get(x.fid) })),
    ].map(target => [target.fid, target]));
    const targets = [];
    for (const target of targetMap.values()) {
      const tkey = `live:forcefinish:${target.fid}`;
      if (await alreadySent(tkey)) continue;
      await markSentTTL(tkey, 120);
      targets.push(target);
    }
    if (targets.length === 0) continue;

    // Una consulta por lote de hasta 20, no una petición por partido. Si hubo
    // 400 stale tras una caída son 20 llamadas, no 400.
    const batch = await fetchDetailedLiveMatches(targets.map(t => t.fid), `reconcile-${d}`);
    apiCalls += batch.apiCalls;
    const realByFid = new Map(
      batch.matches.map(match => [Number(match?.fixture?.id), match]),
    );

    let lsChanged = false, fxChanged = false, rfChanged = false;
    const fxArr = Array.isArray(fx) ? fx : null;

    await Promise.all(targets.map(async ({ fid, kind }) => {
      const real = realByFid.get(Number(fid)) || null;

      if (real && FINISHED_STATUSES.includes(real.fixture?.status?.short)) {
        // ✓ DATOS REALES → liveStats + fixtureStats + fixtures:{d} + match_analysis.
        const stats = extractLiveStats(real, real.events || [], real.statistics || []);
        stats.date = d; stats.savedAt = new Date().toISOString(); stats.realFinal = true;
        if (!hasLs) { ls = {}; hasLs = true; }
        ls[fid] = stats; lsChanged = true;
        try { await redisSet(KEYS.fixtureStats(fid), stats, TTL.yesterday); } catch {}
        void (async () => {
          try { await supabaseAdmin.from('match_analysis').update({ live_stats: stats }).eq('fixture_id', fid); }
          catch (e) { console.error(`[live:force-finish] supabase ${fid}:`, e.message); }
        })();
        if (fxArr) {
          const idx = fxArr.findIndex(f => f.fixture?.id === fid);
          if (idx >= 0) {
            fxArr[idx] = { ...fxArr[idx], fixture: { ...fxArr[idx].fixture, status: real.fixture.status }, goals: real.goals || fxArr[idx].goals, score: real.score || fxArr[idx].score };
            fxChanged = true;
          }
        }
        if (rfSet) { rfSet[fid] = 1; rfChanged = true; }
        finished.push({
          date: d, fixtureId: fid, status: real.fixture.status, goals: real.goals, score: real.score,
          corners: stats.corners, yellowCards: stats.yellowCards, redCards: stats.redCards,
          goalScorers: stats.goalScorers || [], missedPenalties: stats.missedPenalties || [],
        });
        console.log(`[live:force-finish] fid=${fid} (${d}) [${kind}] → FT REAL (${real.goals?.home}-${real.goals?.away})`);
      } else if (real && LIVE_STATUSES.includes(real.fixture?.status?.short)) {
        // El proveedor confirma que sigue en vivo. Nunca forzar FT por reloj:
        // partidos demorados, alargues y suspensiones solo cambian con evidencia.
        const stats = extractLiveStats(real, real.events || [], real.statistics || []);
        if (!hasLs) { ls = {}; hasLs = true; }
        ls[fid] = stats; lsChanged = true;
        try { await redisSet(KEYS.fixtureStats(fid), stats, TTL.fixtureStats); } catch {}
        if (fxArr) {
          const idx = fxArr.findIndex(f => f.fixture?.id === fid);
          if (idx >= 0) {
            fxArr[idx] = { ...fxArr[idx], fixture: { ...fxArr[idx].fixture, status: real.fixture.status }, goals: real.goals || fxArr[idx].goals, score: real.score || fxArr[idx].score };
            fxChanged = true;
          }
        }
        finished.push({
          date: d, fixtureId: fid, status: real.fixture.status, goals: real.goals, score: real.score,
          corners: stats.corners, yellowCards: stats.yellowCards, redCards: stats.redCards,
          goalScorers: stats.goalScorers || [], missedPenalties: stats.missedPenalties || [],
        });
        console.log(`[live:reconcile] fid=${fid} (${d}) ${kind} → ${real.fixture.status.short} REAL`);
      } else if (real && TERMINAL_STATUSES.has(real.fixture?.status?.short)) {
        // Aplazado/cancelado/abandonado: mostrar el estado real, no NS ni un
        // marcador inventado.
        const observed = {
          date: d,
          fixtureId: fid,
          status: real.fixture.status,
          goals: real.goals,
          score: real.score,
          updatedAt: new Date().toISOString(),
        };
        if (!hasLs) { ls = {}; hasLs = true; }
        ls[fid] = observed; lsChanged = true;
        try { await redisSet(KEYS.fixtureStats(fid), observed, TTL.fixtureStats); } catch {}
        if (fxArr) {
          const idx = fxArr.findIndex(f => f.fixture?.id === fid);
          if (idx >= 0) {
            fxArr[idx] = { ...fxArr[idx], fixture: { ...fxArr[idx].fixture, status: real.fixture.status }, goals: real.goals || fxArr[idx].goals, score: real.score || fxArr[idx].score };
            fxChanged = true;
          }
        }
        if (rfSet) { rfSet[fid] = 1; rfChanged = true; }
        finished.push(observed);
        console.log(`[live:reconcile] fid=${fid} (${d}) → ${real.fixture.status.short} REAL`);
      } else if (real && PENDING_STATUSES.has(real.fixture?.status?.short)) {
        // Un endpoint de detalle puede responder NS/TBD durante segundos aunque
        // el feed global ya haya confirmado juego real. Nunca retroceder una
        // evidencia live/final a "no iniciado"; se conserva y se reintenta.
        const previousStatus = ls?.[fid]?.status?.short || fxArr?.find((f) => f.fixture?.id === fid)?.fixture?.status?.short;
        if (kind === 'live' || shouldRejectStatusRegression(previousStatus, real.fixture.status.short)) {
          console.warn(`[live:reconcile] fid=${fid} (${d}) ignora regresion ${previousStatus || kind} → ${real.fixture.status.short}`);
          return;
        }
        const observed = {
          date: d,
          fixtureId: fid,
          status: real.fixture.status,
          goals: real.goals,
          score: real.score,
          updatedAt: new Date().toISOString(),
        };
        if (!hasLs) { ls = {}; hasLs = true; }
        ls[fid] = observed; lsChanged = true;
        try { await redisSet(KEYS.fixtureStats(fid), observed, TTL.fixtureStats); } catch {}
        if (fxArr) {
          const idx = fxArr.findIndex(f => f.fixture?.id === fid);
          if (idx >= 0) {
            fxArr[idx] = { ...fxArr[idx], fixture: { ...fxArr[idx].fixture, status: real.fixture.status }, goals: real.goals, score: real.score };
            fxChanged = true;
          }
        }
        finished.push(observed);
        console.log(`[live:reconcile] fid=${fid} (${d}) ${kind} falso → ${real.fixture.status.short} REAL`);
      }
      // Sin respuesta concluyente no se inventa nada ni se marca: reintenta.
    }));

    if (lsChanged && hasLs) { try { await redisSet(KEYS.liveStats(d), ls, TTL.liveStats); } catch {} }
    if (fxChanged && fxArr)  { try { await redisSet(KEYS.fixtures(d), fxArr, TTL.fixtures); } catch {} }
    if (rfChanged && rfSet)  { try { await redisSet(`live:rf:${d}`, rfSet, 48 * 3600); } catch {} }
  }
  if (apiCalls > 0) { try { await incrementApiCallCount(apiCalls); } catch {} }
  return finished;
}

export async function runLive(_payload = {}) {
  const today = new Date().toISOString().split('T')[0];
  // Schedule cruzando medianoche: un partido que arrancó ~23:30 UTC del día N
  // sigue vivo a las 00:15 UTC del día N+1, pero su entrada está en schedule[N]
  // (no en N+1). Y a la inversa: el cron diario de fixtures corre a las 02:05
  // España (~00:05/01:05 UTC), así que tras medianoche UTC el schedule del
  // día nuevo aún no existe. Si miramos SOLO `today`, podemos:
  //   - perder kickoffs del día anterior que siguen en juego (cross-midnight)
  //   - leer "no fixtures scheduled today" antes de las 02:05 España y SKIPEAR
  //     todo lo de madrugada
  // Solución: unir los kickoffTimes de AYER + HOY + MAÑANA y operar sobre la
  // unión. Es el mismo principio del fix del frontend para cross-midnight.
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const tomorrow  = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const now = Date.now();
  const LL = '[live]';
  const t0 = Date.now();

  // Smart schedule check — skip si no hay matches activos en ninguno de los 3 días.
  async function loadSchedule(d) {
    let s = await redisGet(KEYS.schedule(d));
    if (!s) s = await getMatchSchedule(d).catch(() => null);
    return s;
  }
  const [schedYesterday, schedToday, schedTomorrow] = await Promise.all([
    loadSchedule(yesterday),
    loadSchedule(today),
    loadSchedule(tomorrow),
  ]);
  // Unión de kickoffTimes (cada item es { fixtureId, kickoff, expectedEnd } en
  // ms UTC — timezone-agnóstico, así que se pueden mezclar de los 3 días).
  const allKickoffs = [
    ...((schedYesterday?.kickoffTimes) || []),
    ...((schedToday?.kickoffTimes)     || []),
    ...((schedTomorrow?.kickoffTimes)  || []),
  ];
  const currentScheduleAvailable = (schedToday?.kickoffTimes?.length || 0) > 0;
  console.log(`${LL} tick: today=${today} schedules(y/t/m)=${(schedYesterday?.kickoffTimes?.length||0)}/${(schedToday?.kickoffTimes?.length||0)}/${(schedTomorrow?.kickoffTimes?.length||0)} unión=${allKickoffs.length}`);

  // Red de seguridad: despegar partidos LIVE vencidos (hoy + ayer) ANTES del
  // window-skip, para que nada quede "en vivo" eternamente aunque el tick se
  // salte o el partido cruzara medianoche. API-free.
  const reconciledMatches = await forceFinishOverdueLive(allKickoffs, now, [today, yesterday]);
  if (reconciledMatches.length > 0) {
    console.log(`${LL} reconcile: ${reconciledMatches.length} estado(s) confirmado(s) contra proveedor`);
    const finalsByDate = new Map();
    for (const match of reconciledMatches) {
      if (!FINISHED_STATUSES.includes(match?.status?.short)) continue;
      const matchDate = match.date || today;
      if (!finalsByDate.has(matchDate)) finalsByDate.set(matchDate, []);
      finalsByDate.get(matchDate).push(match.fixtureId);
    }
    await Promise.all([...finalsByDate.entries()].map(([matchDate, fixtureIds]) => (
      enqueueImmediateFinalization(matchDate, fixtureIds)
    )));
    // El helper ya corrigió liveStats + fixtures:{d} + fixtureStats con datos
    // reales. Aquí solo broadcasteamos para que el front lo despegue/actualice
    // al instante (status + marcador + goleadores reales).
    triggerEvent('live-scores', 'update', {
      date: today, liveCount: 0, matches: reconciledMatches,
      timestamp: new Date().toISOString(), reconciliation: true,
    }).catch(() => {});
  }

  // Si falta el calendario ACTUAL no podemos usar el de ayer para concluir
  // que "ya acabó el día": ese fue exactamente el incidente del 02/08. En
  // degradación el feed live es la fuente de verdad y se consulta cada tick.
  if (!currentScheduleAvailable) {
    console.warn(`${LL} calendario de ${today} ausente → fail-open al feed live`);
  } else if (allKickoffs.length > 0) {
    // Ventana global: del primer kickoff (de cualquier día) al último expectedEnd.
    const firstKickoff    = Math.min(...allKickoffs.map(m => Number(m.kickoff)).filter(Number.isFinite));
    const lastExpectedEnd = Math.max(...allKickoffs.map(m => Number(m.expectedEnd)).filter(Number.isFinite));

    if (Number.isFinite(firstKickoff) && now < firstKickoff - 5 * 60 * 1000) {
      const minsTo = Math.round((firstKickoff - now) / 60000);
      console.log(`${LL} SKIP: before first kickoff (${minsTo} min restantes — ventana global y/t/m)`);
      return { ok: true, skipped: true, reason: 'before first kickoff', apiCalls: 0 };
    }
    if (Number.isFinite(lastExpectedEnd) && now > lastExpectedEnd + 30 * 60 * 1000) {
      const minsAgo = Math.round((now - lastExpectedEnd) / 60000);
      console.log(`${LL} SKIP: after last expected end + 30min (último kickoff terminó hace ${minsAgo} min — ventana global y/t/m)`);
      return { ok: true, skipped: true, reason: 'after last expected end + 30min', apiCalls: 0 };
    }

    const hasActiveMatch = allKickoffs.some(m => {
      const kickoff = Number(m.kickoff);
      const expectedEnd = Number(m.expectedEnd);
      return now >= kickoff - 5 * 60 * 1000 && now <= expectedEnd;
    });

    if (!hasActiveMatch) {
      const lastRun = await redisGet('live-cron:last-run');
      if (lastRun && Number(lastRun) > now - 10 * 60 * 1000) {
        console.log(`${LL} SKIP: no active matches in 5min-window y last-run reciente (<10min)`);
        return { ok: true, skipped: true, reason: 'no active matches in window', apiCalls: 0 };
      }
      console.log(`${LL} schedule sin match activo en ventana, pero last-run viejo → CONTINÚA a la API`);
    } else {
      console.log(`${LL} schedule OK: hay match activo en ventana → continúa`);
    }
  } else {
    console.log(`${LL} sin schedules en Redis/BD para y/t/m → asumiendo activo, va a la API`);
  }

  await redisSet('live-cron:last-run', String(now), 600);

  const allLive = await apiFetch('/fixtures?live=all');
  let apiCalls = 1;
  if (!allLive) {
    // null = cuota agotada, error de la API o red caída. apiFetch ya lo logueó
    // a stdout (visible en pm2 logs). NO lanzamos: con attempts:1 el cron del
    // minuto siguiente reintenta solo, y un throw aquí dispararía alerta de
    // Telegram cada minuto mientras dure la cuota agotada.
    console.log(`${LL} SKIP: apiFetch /fixtures?live=all devolvió null (cuota agotada, error o red caída)`);
    return { ok: true, skipped: true, reason: 'API sin datos (cuota agotada / error API / red)' };
  }
  console.log(`${LL} /fixtures?live=all → ${allLive.length} partidos en vivo (todas las ligas)`);

  const YOUTH_RE = /\bU-?1[2-9]\b|\bU-?2[0-3]\b|\bunder[ -]?(1[2-9]|2[0-3])\b|\byouth\b|\bjunior\b|\bsub-?(1[2-9]|2[0-3])\b/i;
  // NOMBRES DE EQUIPO: sin "junior" (Junior de Barranquilla = club absoluto);
  // "youth"/"juvenil" solo al final ("Qingdao Youth Island" es club, no cazar).
  const YOUTH_TEAM_RE = /\bU-?1[2-9]\b|\bU-?2[0-3]\b|\bunder[ -]?(1[2-9]|2[0-3])\b|\bsub-?(1[2-9]|2[0-3])\b|\b(youth|juvenil)\s*$/i;
  const tracked = allLive.filter(m => ALL_LEAGUE_IDS.includes(m.league.id) && !YOUTH_RE.test(m.league.name || '') &&
    !YOUTH_TEAM_RE.test(m.teams?.home?.name || '') && !YOUTH_TEAM_RE.test(m.teams?.away?.name || ''));
  console.log(`${LL} tracked (filtrado por ALL_LEAGUE_IDS + no-youth): ${tracked.length}/${allLive.length}`);
  if (tracked.length === 0 && allLive.length > 0) {
    // Diagnóstico: ¿qué ligas vinieron de la API que NO estamos rastreando?
    const ligasOut = [...new Set(allLive.map(m => `${m.league?.id}:${m.league?.name}`))].slice(0, 10);
    console.log(`${LL} ⚠ NINGÚN partido en ALL_LEAGUE_IDS. Ligas en API (sample 10): ${ligasOut.join(' | ')}`);
  } else if (tracked.length > 0) {
    const sample = tracked.slice(0, 5).map(m => `${m.fixture.id}(${m.league?.id}) ${m.teams?.home?.name?.slice(0,12)}-${m.teams?.away?.name?.slice(0,12)} ${m.fixture.status?.short}${m.fixture.status?.elapsed ? ' '+m.fixture.status.elapsed+"'" : ''} ${m.goals?.home}-${m.goals?.away}`);
    console.log(`${LL} tracked sample: ${sample.join(' | ')}`);
  }

  const liveDetailsMap = {};
  for (const match of tracked) {
    const fid = match.fixture.id;
    const liveData = extractLiveStats(match, match.events || [], match.statistics || []);
    liveData.date = today;
    liveDetailsMap[fid] = liveData;

    if (FINISHED_STATUSES.includes(match.fixture.status.short)) {
      liveData.savedAt = new Date().toISOString();
      liveData.realFinal = true; // capturado del feed con status FINISHED → dato real confirmado
      await redisSet(KEYS.fixtureStats(fid), liveData, TTL.yesterday);
      // Fire-and-forget Supabase write. PostgrestFilterBuilder is thenable
      // but not a real Promise — wrap in async IIFE to get proper try/catch.
      void (async () => {
        try {
          await supabaseAdmin.from('match_analysis')
            .update({ live_stats: liveData })
            .eq('fixture_id', fid);
        } catch (e) {
          console.error(`[live] supabase stats save ${fid}:`, e.message);
        }
      })();
    }
  }

  // NT8: broadcast TEMPRANO del marcador (del feed principal /fixtures?live=all)
  // ANTES del detalle batched y la reconciliación stale, que pueden
  // tardar varios segundos. Así la UI ve el gol/marcador por WS lo antes posible;
  // el broadcast final (con córners/stats enriquecidos) va igual al terminar el tick.
  // Fire-and-forget — no bloquea el tick.
  try {
    const earlyUpdates = tracked.map(m => {
      const d = liveDetailsMap[m.fixture.id];
      return {
        fixtureId: m.fixture.id,
        status: m.fixture.status,
        goals: m.goals,
        score: m.score,
        corners: d?.corners?.isReal ? d.corners : null,
        yellowCards: d?.yellowCards || null,
        redCards: d?.redCards || null,
        goalScorers: d?.goalScorers || [],
        missedPenalties: d?.missedPenalties || [],
      };
    });
    if (earlyUpdates.length > 0) {
      triggerEvent('live-scores', 'update', {
        date: today, liveCount: tracked.length, matches: earlyUpdates,
        timestamp: new Date().toISOString(), partial: true,
      }).catch(() => {});
    }
  } catch (e) { console.error(`${LL} early broadcast fallo:`, e.message); }

  const existingLive = (await redisGet(KEYS.liveStats(today))) || {};

  // Un único fan-out en lotes de 20 sustituye las dos rondas legacy por partido
  // (`/fixtures?id=X` para goleador + `/fixtures/statistics?fixture=X`). Cada
  // fixture detallado ya contiene events, statistics y players, así que el mismo
  // payload alimenta TODO el canal live. Para 36 partidos: 2 llamadas en vez de
  // 36–72; para 400 simultáneos: 20, siempre con el mismo refresco de 90 s.
  const detailResult = await fetchDetailedLiveMatches(tracked);
  apiCalls += detailResult.apiCalls;
  const detailedById = new Map(detailResult.matches
    .map(match => [Number(match?.fixture?.id), match])
    .filter(([fid]) => Number.isFinite(fid)));

  for (const match of tracked) {
    const fid = Number(match.fixture.id);
    const detailed = detailedById.get(fid);
    if (!detailed) continue; // conserva el extract del feed principal
    const events = Array.isArray(detailed.events) && detailed.events.length > 0
      ? detailed.events
      : (match.events || []);
    const stats = Array.isArray(detailed.statistics) && detailed.statistics.length > 0
      ? detailed.statistics
      : (match.statistics || []);
    const fullData = extractLiveStats(detailed, events, stats);
    fullData.date = today;
    liveDetailsMap[fid] = fullData;
  }

  let playerActivityUpdates = new Map();
  try {
    playerActivityUpdates = await buildPlayerActivityUpdates(detailResult.matches);
  } catch (e) {
    // La actividad individual enriquece el push, pero un fallo inesperado no
    // puede interrumpir goles, marcador ni el resto del tick.
    console.error('[live:players] enriquecimiento omitido en este tick:', e.message);
  }

  // ── BUG FIX (córners monótonos por-lado) ──
  // Los córners SOLO suben dentro de un partido. La API-Football provoca dos
  // problemas que hacían "bajar" un lado y perder/pisar valores:
  //   (a) tick entero sin stats → extractor pone 0-0 (isReal=false);
  //   (b) PEOR y más sutil (caso Paderborn 8-1 → mostraba 8-0): un tick trae el
  //       córner de HOME real (8) pero el de AWAY como null → extractor pone
  //       away=0 y, como `cornersAreReal` es un OR, marca isReal=true. El merge
  //       de abajo entonces pisaba el 8-1 guardado con 8-0.
  // FIX único y robusto: forzar que cada lado NUNCA baje por debajo del último
  // valor conocido (existingLive). Tomamos el máximo por-lado. Mutamos
  // liveDetailsMap para que TODO (push, merge, fixtureStats, Pusher) use el
  // valor monótono de forma consistente.
  for (const [fid, data] of Object.entries(liveDetailsMap)) {
    const prevC = existingLive[fid]?.corners;
    if (!data?.corners || !prevC) continue;
    const ph = prevC.home ?? 0, pa = prevC.away ?? 0;
    const ch = data.corners.home ?? 0, ca = data.corners.away ?? 0;
    if (ph > ch || pa > ca) {
      const home = Math.max(ph, ch), away = Math.max(pa, ca);
      data.corners = { home, away, total: home + away, isReal: data.corners.isReal === true || prevC.isReal === true };
      console.log(`${LL} corners monótono fid=${fid}: tick ${ch}-${ca} → ${home}-${away} (piso por-lado, no bajar bajo prev ${ph}-${pa})`);
    }
  }

  // ── Snapshot durable de medio tiempo ──────────────────────────────────────
  // Para los partidos en HT, el contador actual de córners/tiros/faltas/offsides
  // ES el total de la 1ª parte (la API nunca los da con minuto). Se persiste a
  // raw_api_payloads para los mercados por mitad. Fire-and-forget (no bloquea el
  // tick ni los pushes). Idempotente entre ticks de HT.
  for (const [fid, data] of Object.entries(liveDetailsMap)) {
    if (data?.status?.short !== 'HT') continue;
    const match = tracked.find(m => m.fixture.id === Number(fid));
    if (match) void persistHalfStatsSnapshot(match, data);
  }

  // Fire-and-forget pushes — 1 bundle por fixture/tick con los eventos pedidos:
  // goles/anulados, córners, tarjetas, penaltis, remates y faltas. Sustituciones
  // y VAR genérico quedan fuera. Anti-spam por agrupación en el propio bundle.
  console.log(`${LL} → sendBundledPushes: liveDetailsMap=${Object.keys(liveDetailsMap).length} existingLive=${Object.keys(existingLive).length}`);
  sendBundledPushes(liveDetailsMap, existingLive, today, playerActivityUpdates)
    .catch(err => console.error('[live:bundled-pushes]', err.message, err.stack));

  const mergedLive = { ...existingLive };
  for (const [fid, data] of Object.entries(liveDetailsMap)) {
    const existing = existingLive[fid];
    mergedLive[fid] = {
      ...data,
      corners: data.corners?.total > 0 ? data.corners : (existing?.corners || data.corners),
      offsides: data.offsides?.total > 0 ? data.offsides : (existing?.offsides || data.offsides),
      goalScorers: data.goalScorers?.length > 0 ? data.goalScorers : (existing?.goalScorers || []),
      missedPenalties: data.missedPenalties?.length > 0 ? data.missedPenalties : (existing?.missedPenalties || []),
      // Listas de eventos discretos: preservar las del tick previo si la
      // API esta vez devolvió vacío (sucede cuando /fixtures?live=all no
      // trae events y no se hizo el fetch detallado por fixture).
      substitutions: data.substitutions?.length > 0 ? data.substitutions : (existing?.substitutions || []),
      varEvents:     data.varEvents?.length > 0     ? data.varEvents     : (existing?.varEvents || []),
      penaltyEvents: data.penaltyEvents?.length > 0 ? data.penaltyEvents : (existing?.penaltyEvents || []),
    };
  }

  if (Object.keys(liveDetailsMap).length > 0) {
    await Promise.all(
      Object.entries(liveDetailsMap).map(([fid, data]) =>
        redisSet(KEYS.fixtureStats(fid), data, TTL.fixtureStats)
      )
    );
  }

  // Stale match detection
  const finishedUpdates = [];
  let staleFixedCount = 0;
  const currentLiveIds = new Set(tracked.map(m => m.fixture.id));
  const cachedFixturesForToday = await redisGet(KEYS.fixtures(today)).catch(() => null);
  const staleIds = collectStaleLiveFixtureIds(existingLive, cachedFixturesForToday, currentLiveIds);

  if (staleIds.length > 0) {
    const staleDetailResult = await fetchDetailedLiveMatches(staleIds, 'stale');
    apiCalls += staleDetailResult.apiCalls;
    const staleById = new Map(staleDetailResult.matches
      .map(match => [Number(match?.fixture?.id), match])
      .filter(([fid]) => Number.isFinite(fid)));

    await Promise.all(staleIds.map(async (fid) => {
      const fresh = staleById.get(fid);
      if (fresh) {
        const freshStatus = fresh.fixture.status.short;
        if (FINISHED_STATUSES.includes(freshStatus)) {
          const statsArr = fresh.statistics || [];
          const fullStats = extractLiveStats(fresh, fresh.events || [], statsArr);
          // Si la liga no ofrece estadísticas finales, conservar el último
          // contador real observado; no hacer otra llamada individual ni
          // convertir un dato conocido en cero.
          const previous = existingLive[fid];
          if (statsArr.length === 0 && previous) {
            for (const field of ['corners', 'offsides', 'shots', 'sot', 'fouls']) {
              if (previous[field]?.isReal && !fullStats[field]?.isReal) fullStats[field] = previous[field];
            }
            if ((fullStats.goalScorers || []).length === 0) fullStats.goalScorers = previous.goalScorers || [];
            if ((fullStats.cardEvents || []).length === 0) fullStats.cardEvents = previous.cardEvents || [];
          }
          fullStats.date = today;
          fullStats.savedAt = new Date().toISOString();
          fullStats.realFinal = true; // stale-detection confirmó FT contra la API → dato real
          await redisSet(KEYS.fixtureStats(fid), fullStats, TTL.yesterday);
          // Fire-and-forget Supabase write. PostgrestFilterBuilder is thenable
          // but not a real Promise — wrap in async IIFE to get proper try/catch.
          void (async () => {
            try {
              await supabaseAdmin.from('match_analysis')
                .update({ live_stats: fullStats })
                .eq('fixture_id', fid);
            } catch (e) {
              console.error(`[live:stale] supabase stats save ${fid}:`, e.message);
            }
          })();
          mergedLive[fid] = { ...fullStats, status: fresh.fixture.status };
          staleFixedCount++;
          finishedUpdates.push({ fixtureId: fid, status: fresh.fixture.status, goals: fresh.goals, score: fresh.score, corners: fullStats.corners, yellowCards: fullStats.yellowCards, redCards: fullStats.redCards, goalScorers: fullStats.goalScorers || [], missedPenalties: fullStats.missedPenalties || [] });
        } else {
          const previous = existingLive[fid] || {};
          const previousStatus = previous.status?.short
            || cachedFixturesForToday?.find((fixture) => Number(fixture?.fixture?.id) === fid)?.fixture?.status?.short;
          if (shouldRejectStatusRegression(previousStatus, freshStatus)) {
            console.warn(`[live:stale] fid=${fid} ignora regresion ${previousStatus} → ${freshStatus}`);
            return;
          }
          mergedLive[fid] = {
            ...previous,
            status: fresh.fixture.status || previous.status,
            goals: fresh.goals || previous.goals,
            score: fresh.score || previous.score,
            updatedAt: new Date().toISOString(),
          };
          finishedUpdates.push({ fixtureId: fid, status: fresh.fixture.status, goals: fresh.goals, score: fresh.score });
        }
      }
    }));
  }

  if (Object.keys(mergedLive).length > 0) {
    await redisSet(KEYS.liveStats(today), mergedLive, TTL.liveStats);
  }

  // Update fixtures:{date} with latest status
  const allUpdatedIds = new Set([...tracked.map(m => m.fixture.id), ...staleIds]);
  if (allUpdatedIds.size > 0) {
    const cachedFixtures = cachedFixturesForToday;
    if (Array.isArray(cachedFixtures) && cachedFixtures.length > 0) {
      let changed = false;
      const updated = cachedFixtures.map(f => {
        const fid = f.fixture?.id;
        if (!fid || !allUpdatedIds.has(fid)) return f;
        const live = mergedLive[fid];
        if (!live?.status) return f;
        if (shouldRejectStatusRegression(f.fixture.status.short, live.status.short)) return f;
        if (f.fixture.status.short === live.status.short &&
            (f.fixture.status.elapsed || 0) >= (live.status.elapsed || 0)) return f;
        changed = true;
        return { ...f, fixture: { ...f.fixture, status: live.status }, goals: live.goals || f.goals, score: live.score || f.score };
      });
      if (changed) redisSet(KEYS.fixtures(today), updated, TTL.fixtures).catch(() => {});
    }
  }

  await enqueueImmediateFinalization(
    today,
    finishedUpdates
      .filter((match) => FINISHED_STATUSES.includes(match?.status?.short))
      .map((match) => match.fixtureId),
  );

  // Pusher update
  const allPusherUpdates = [];
  tracked.forEach(m => {
    const fid = m.fixture.id;
    const details = liveDetailsMap[fid];
    const merged = mergedLive[fid];
    allPusherUpdates.push({
      fixtureId: fid,
      status: m.fixture.status,
      goals: m.goals,
      score: m.score,
      corners: merged?.corners?.isReal ? merged.corners : (details?.corners?.isReal ? details.corners : null),
      yellowCards: details?.yellowCards || null,
      redCards: details?.redCards || null,
      goalScorers: details?.goalScorers || [],
      missedPenalties: details?.missedPenalties || [],
    });
  });
  allPusherUpdates.push(...finishedUpdates);

  if (allPusherUpdates.length > 0) {
    await triggerEvent('live-scores', 'update', {
      date: today, liveCount: tracked.length, matches: allPusherUpdates, timestamp: new Date().toISOString(),
    });
  }

  if (apiCalls > 0) await incrementApiCallCount(apiCalls); // NT7: 1 INCRBY en vez de N INCR

  console.log(`${LL} ✓ done en ${Date.now() - t0}ms — tracked=${tracked.length} totalLive=${allLive.length} staleFixed=${staleFixedCount} apiCalls=${apiCalls}`);

  return {
    ok: true,
    liveCount: tracked.length,
    totalLive: allLive.length,
    staleFixed: staleFixedCount,
    apiCalls,
  };
}
