// @ts-nocheck
/**
 * Job: futbol-live
 * Port of /api/cron/live. Polls live fixtures from API-Football, persists
 * stats to Redis + Supabase, sends Pusher updates and push notifications
 * for goals on favorited matches.
 *
 * Payload: {}
 */
import {
  ALL_LEAGUE_IDS, triggerEvent,
  redisGet, redisSet, KEYS, TTL,
  incrementApiCallCount, sendPushNotification,
  supabaseAdmin, getMatchSchedule,
} from '../../shared.js';

const API_HOST = 'v3.football.api-sports.io';
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const LIVE_STATUSES = ['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE'];

async function apiFetch(endpoint) {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://${API_HOST}${endpoint}`, {
      headers: { 'x-apisports-key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error('[live] API error:', data.errors);
      return null;
    }
    return data.response || [];
  } catch (e) {
    console.error('[live] apiFetch network error:', endpoint, e.message);
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
  // explícito para que el caller (live.js) sepa que tiene que hacer fetch al
  // endpoint dedicado /fixtures/statistics?fixture=X. NO usamos 0 como default
  // porque "0 corners en el min 80" sería un dato real, mientras que null = "no
  // sabemos". Esto distingue "API no reporta" vs "el partido realmente no tuvo".
  const hCornersRaw = getVal(homeStats, 'Corner Kicks', 'Corners', 'Corner');
  const aCornersRaw = getVal(awayStats, 'Corner Kicks', 'Corners', 'Corner');
  const hCorners = hCornersRaw ?? 0;
  const aCorners = aCornersRaw ?? 0;
  const cornersAreReal = hCornersRaw !== null || aCornersRaw !== null;

  // Cards: fallback a contar events SIEMPRE que stats no haya devuelto dato
  // explícito. El bug previo (`getVal(...) || count`) tiraba el 0 legítimo del
  // stat y caía al fallback, doblando el conteo. Ahora: si stat es null →
  // fallback events; si stat es 0 → 0 (real); si stat > 0 → ese valor.
  const yhStat = getVal(homeStats, 'Yellow Cards', 'Yellowcards');
  const yaStat = getVal(awayStats, 'Yellow Cards', 'Yellowcards');
  const rhStat = getVal(homeStats, 'Red Cards', 'Redcards');
  const raStat = getVal(awayStats, 'Red Cards', 'Redcards');
  const hYellow = yhStat ?? cardEvents.filter(e => e.teamId === homeId && e.type === 'Yellow Card').length;
  const aYellow = yaStat ?? cardEvents.filter(e => e.teamId === awayId && e.type === 'Yellow Card').length;
  const hRed = rhStat ?? cardEvents.filter(e => e.teamId === homeId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;
  const aRed = raStat ?? cardEvents.filter(e => e.teamId === awayId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;

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
  const hOffsides = hOffsidesRaw ?? 0;
  const aOffsides = aOffsidesRaw ?? 0;

  return {
    fixtureId: match.fixture.id,
    status: match.fixture.status,
    goals: match.goals,
    score: match.score,
    homeTeam: { id: homeId, name: match.teams.home.name },
    awayTeam: { id: awayId, name: match.teams.away.name },
    corners: { home: hCorners, away: aCorners, total: hCorners + aCorners, isReal: cornersAreReal },
    yellowCards: { home: hYellow, away: aYellow, total: hYellow + aYellow },
    redCards: { home: hRed, away: aRed, total: hRed + aRed },
    offsides: { home: hOffsides, away: aOffsides, total: hOffsides + aOffsides },
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
// deltas detectados desde el live anterior:
//   ⚽ Goles · 🚩 córners · 🟨 amarillas · 🟥 rojas/expulsiones ·
//   🔄 sustituciones · 🅿️ penalti · 📺 VAR (gol anulado / penalti anulado)
//
// REGLA DE CALIDAD: solo notificamos eventos con datos REALES de API-Football
// (array `events` con jugador/equipo concretos). NO se notifican estadísticas
// agregadas sin contexto: los offsides (eliminados — solo vienen como contador
// del stat, sin jugador, sin acción concreta). Tarjetas/cambios sin jugador
// también se saltan. Mejor 1 push correcto que 5 ruidosos.
//
// Si un partido tiene en un mismo tick (1 minuto): 2 córners + 1 amarilla
// + 1 cambio, se envía UN solo push compuesto en lugar de 4 separados.
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

// Key estable para deduplicar eventos en listas (subst, var, penalty).
// Lo usamos para comparar contra el tick anterior.
function evKey(ev) {
  return `${ev.minute ?? '?'}|${ev.extra ?? 0}|${ev.player ?? ''}|${ev.teamId ?? ''}|${ev.detail ?? ev.kind ?? ev.type ?? ''}`;
}

// ─── Deduplicación cross-tick por Redis ────────────────────────────────────
// PROBLEMA QUE RESUELVE: el mismo evento se notificaba 2-3 veces en ticks
// consecutivos de 20s. Causa: `existingLive` se lee de Redis al inicio del
// tick, pero `mergedLive` (con los contadores nuevos) se ESCRIBE de vuelta a
// Redis DESPUÉS de invocar sendBundledPushes (que es fire-and-forget). Si el
// siguiente tick de 20s arranca antes de que esa escritura se vea reflejada
// (latencia de Redis, pipelining, o porque sendBundledPushes await-ea
// subscriptions y favoritos primero), `existingLive` en el tick N+1 sigue
// mostrando los contadores viejos → mismo delta → mismo push.
//
// FIX: en lugar de confiar solo en `existingLive` para evitar repeticiones,
// marcamos en Redis con TTL=90s (3 ticks de 20s + buffer) una clave por
// EVENTO ya notificado:
//   push:sent:{fid}:goal:home:{count}        — gol home cuando contador llega a N
//   push:sent:{fid}:corner:home:{count}      — cada córner home en valor exacto
//   push:sent:{fid}:yellow:{teamId}:{count}  — amarilla por equipo y valor
//   push:sent:{fid}:red:{teamId}:{count}
//   push:sent:{fid}:subst:{evKey}            — eventos de lista por su evKey
//   push:sent:{fid}:penalty:{evKey}
//   push:sent:{fid}:var:{evKey}
//
// Antes de añadir la línea al bundle, comprobamos cada clave. Si existe →
// skip. Las claves quedan en Redis con TTL y desaparecen solas; el evento
// (que es estrictamente posterior a "ese contador en ese valor") nunca se
// repetirá dentro de esa ventana.
//
// TTL POR TIPO DE EVENTO: eventos "de una vez" en el partido (gol, amarilla,
// roja, cambio, penalti) usan 7200s (2h) para que NO se re-notifiquen aunque
// la API reordene/reenvíe el evento mucho después. Eventos de contador que
// suben varias veces (córner) o decisiones puntuales (VAR) mantienen el TTL
// corto de 90s: su clave ya incluye el valor exacto del contador / evKey, así
// que un TTL largo no aporta y un valor nuevo (otro córner) debe poder
// notificarse en cuanto ocurra.
const DEDUP_TTL_SEC = 90; // default (córner, VAR)
const DEDUP_TTL_BY_TYPE = {
  goal: 7200,
  yellow: 7200,
  red: 7200,
  subst: 7200,
  penalty: 7200,
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

// Igual que markSent pero con TTL explícito (usado por el throttle de
// stats-fetch, que necesita una ventana distinta a la dedup de eventos).
async function markSentTTL(key, ttlSec) {
  try { await redisSet(key, 1, ttlSec); } catch {}
}

async function buildEventBundle(fid, data, prev) {
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
    subst:   { base: (prev.substitutions || []).length, now: (data.substitutions || []).length },
    pen:     { base: (prev.penaltyEvents || []).length, now: (data.penaltyEvents || []).length },
    var:     { base: (prev.varEvents || []).length, now: (data.varEvents || []).length },
  };
  console.log(`${DP} fid=${fid} ${home}-${away} min=${minute}' | ` +
    `goals base=${snap.goals.base} now=${snap.goals.now} | ` +
    `corners base=${snap.corners.base}(real=${snap.corners.baseReal}) now=${snap.corners.now}(real=${snap.corners.nowReal}) | ` +
    `yellow base=${snap.yellow.base} now=${snap.yellow.now} | ` +
    `red base=${snap.red.base} now=${snap.red.now} | ` +
    `subst base=${snap.subst.base} now=${snap.subst.now} | ` +
    `pen base=${snap.pen.base} now=${snap.pen.now} | ` +
    `var base=${snap.var.base} now=${snap.var.now}`);

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
  const goalDetail = (g) => g?.type === 'Penalty' ? ' (de penalti)'
                        : g?.type === 'Own Goal' ? ' (en propia)'
                        : '';
  if (nHG > pHG) {
    const k = dedupKey(fid, 'goal', 'home', nHG);
    if (!(await alreadySent(k))) {
      // Tomamos el ÚLTIMO gol del equipo correcto (no slice(-1) ciego, que
      // podía dar el del otro equipo si la API los devuelve mezclados).
      const last = (data.goalScorers || []).filter(g => g.teamName === home).slice(-1)[0];
      const who = last?.player ? ` · ${last.player}` : '';
      lines.push(`⚽ GOL · ${home} ${nHG}-${nAG}${who}${goalDetail(last)}`);
      sentKeys.push(k);
      urgent = true;
      console.log(`${DP} fid=${fid} GOL home delta ${pHG}→${nHG} ⇒ línea añadida`);
    } else {
      skipReasons.push(`goal-home(${nHG}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} GOL home delta ${pHG}→${nHG} pero dedup key ya marcada ⇒ SKIP`);
    }
  }
  if (nAG > pAG) {
    const k = dedupKey(fid, 'goal', 'away', nAG);
    if (!(await alreadySent(k))) {
      const last = (data.goalScorers || []).filter(g => g.teamName === away).slice(-1)[0];
      const who = last?.player ? ` · ${last.player}` : '';
      lines.push(`⚽ GOL · ${away} ${nHG}-${nAG}${who}${goalDetail(last)}`);
      sentKeys.push(k);
      urgent = true;
      console.log(`${DP} fid=${fid} GOL away delta ${pAG}→${nAG} ⇒ línea añadida`);
    } else {
      skipReasons.push(`goal-away(${nAG}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} GOL away delta ${pAG}→${nAG} pero dedup key ya marcada ⇒ SKIP`);
    }
  }

  // ── Córners ── REAL: pasó un córner, sabemos qué equipo lo lanza.
  // API-Football NO expone córners como events con jugador (solo el contador
  // en stats por equipo). Por tanto no podemos dar el lanzador, pero la
  // información de "córner para X" SÍ es real (no es una estadística
  // ambigua como offsides — un córner se pita o no se pita).
  const pHC = prev.corners?.home ?? 0, pAC = prev.corners?.away ?? 0;
  const nHC = data.corners?.home ?? 0, nAC = data.corners?.away ?? 0;
  if (nHC > pHC) {
    const k = dedupKey(fid, 'corner', 'home', nHC);
    if (!(await alreadySent(k))) {
      lines.push(`🚩 Córner · ${home} (${nHC}-${nAC})`);
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
      lines.push(`🚩 Córner · ${away} (${nHC}-${nAC})`);
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
      const who = lastCard?.player ? ` · ${lastCard.player}` : '';
      lines.push(`🟨 Amarilla · ${home}${who}`);
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
      const who = lastCard?.player ? ` · ${lastCard.player}` : '';
      lines.push(`🟨 Amarilla · ${away}${who}`);
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
      const who = lastCard?.player ? ` · ${lastCard.player}` : '';
      const how = lastCard?.type === 'Second Yellow card' ? ' (2ª amarilla)' : '';
      lines.push(`🟥 EXPULSADO · ${home}${who}${how}`);
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
      const who = lastCard?.player ? ` · ${lastCard.player}` : '';
      const how = lastCard?.type === 'Second Yellow card' ? ' (2ª amarilla)' : '';
      lines.push(`🟥 EXPULSADO · ${away}${who}${how}`);
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

  // ── Sustituciones (lista) ── REAL: API da player (sale) y assist (entra)
  // como evento type='subst'. Si por algún motivo falta uno de los dos, NO
  // notificamos — "🔄 Equipo · ? → ?" sería ruido sin información.
  const prevSubKeys = new Set((prev.substitutions || []).map(evKey));
  const newSubs = (data.substitutions || []).filter(s => !prevSubKeys.has(evKey(s)));
  if (newSubs.length > 0) console.log(`${DP} fid=${fid} CAMBIO ${newSubs.length} evento(s) nuevo(s) vs baseline`);
  for (const s of newSubs) {
    if (!s.playerOut || !s.playerIn) {
      skipReasons.push(`subst:incompleto(out=${s.playerOut || '?'},in=${s.playerIn || '?'})`);
      console.log(`${DP} fid=${fid} CAMBIO incompleto (out=${s.playerOut || '?'} in=${s.playerIn || '?'}) ⇒ SKIP`);
      continue; // saltar sustituciones incompletas
    }
    const k = dedupKey(fid, 'subst', evKey(s));
    if (await alreadySent(k)) {
      skipReasons.push(`subst:dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} CAMBIO ${s.playerOut}→${s.playerIn} dedup ya marcada ⇒ SKIP`);
      continue;
    }
    lines.push(`🔄 Cambio · ${s.teamName || '?'} · ${s.playerOut} → ${s.playerIn}`);
    sentKeys.push(k);
    console.log(`${DP} fid=${fid} CAMBIO ${s.teamName} ${s.playerOut}→${s.playerIn} ⇒ línea añadida`);
  }

  // ── Penaltis (lista — scored/missed/awarded) ──
  const prevPenKeys = new Set((prev.penaltyEvents || []).map(evKey));
  const newPens = (data.penaltyEvents || []).filter(p => !prevPenKeys.has(evKey(p)));
  if (newPens.length > 0) console.log(`${DP} fid=${fid} PENALTI ${newPens.length} evento(s) nuevo(s) vs baseline`);
  for (const p of newPens) {
    const k = dedupKey(fid, 'penalty', evKey(p));
    if (await alreadySent(k)) {
      skipReasons.push(`penalty(${p.kind}):dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} PENALTI ${p.kind} dedup ya marcada ⇒ SKIP`);
      continue;
    }
    const verb = p.kind === 'scored' ? 'convertido' : p.kind === 'missed' ? 'fallado' : 'señalado';
    lines.push(`🅿️ Penalti ${verb} · ${p.teamName || '?'}${p.player ? ` · ${p.player}` : ''}`);
    sentKeys.push(k);
    urgent = true;
    console.log(`${DP} fid=${fid} PENALTI ${verb} ${p.teamName} ⇒ línea añadida`);
  }

  // ── VAR (gol anulado / penalti anulado / decisión cambiada) ──
  const prevVarKeys = new Set((prev.varEvents || []).map(evKey));
  const newVars = (data.varEvents || []).filter(v => !prevVarKeys.has(evKey(v)));
  if (newVars.length > 0) console.log(`${DP} fid=${fid} VAR ${newVars.length} evento(s) nuevo(s) vs baseline`);
  for (const v of newVars) {
    const k = dedupKey(fid, 'var', evKey(v));
    if (await alreadySent(k)) {
      skipReasons.push(`var:dedup-ya-enviado`);
      console.log(`${DP} fid=${fid} VAR ${v.detail} dedup ya marcada ⇒ SKIP`);
      continue;
    }
    const det = v.detail || 'VAR';
    lines.push(`📺 ${det} · ${v.teamName || '?'}${v.player ? ` · ${v.player}` : ''}`);
    sentKeys.push(k);
    urgent = true;
    console.log(`${DP} fid=${fid} VAR ${det} ${v.teamName} ⇒ línea añadida`);
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

  // Título: marcador en vivo + minuto. Body: líneas concatenadas (max ~3 líneas
  // visibles en la notificación expandida; el resto se trunca silenciosamente).
  const title = `${home} ${nHG}-${nAG} ${away} · ${minute}'`;
  const body = lines.slice(0, 6).join('\n');
  // Tag estable por fixture+minuto+nEventos para que múltiples ticks no
  // sobrescriban notificaciones distintas. FCM reemplaza notifs con mismo tag.
  const tag = `live-${fid}-${minute}-${lines.length}`;
  // sentKeys: el caller marca cada una en Redis DESPUÉS de enviar el push
  // (ver sendBundledPushes), no aquí. Si marcamos antes de enviar y el envío
  // falla, perdemos el evento para siempre. Marcar después es at-least-once.
  return { fixtureId: Number(fid), title, body, tag, urgent, sentKeys };
}

async function sendBundledPushes(liveDetailsMap, existingLive) {
  const LP = '[live:push]';
  // 1. Construir bundles por fixture (solo cuando hay deltas y baseline previa).
  // buildEventBundle es ahora async porque consulta dedup keys en Redis.
  const fids = Object.keys(liveDetailsMap);
  const withBaseline = fids.filter(fid => existingLive[fid]).length;
  const bundles = [];
  for (const [fid, data] of Object.entries(liveDetailsMap)) {
    const prev = existingLive[fid];
    if (!prev) continue; // sin baseline → no notificamos el estado inicial
    const bundle = await buildEventBundle(fid, data, prev);
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
    }
    return;
  }

  const favoritesByUser = {};
  await Promise.all(subs.map(async (row) => {
    if (favoritesByUser[row.user_id] !== undefined) return;
    const { data: favRows } = await supabaseAdmin
      .from('user_favorites')
      .select('fixture_id')
      .eq('user_id', row.user_id);
    favoritesByUser[row.user_id] = new Set((favRows || []).map(r => Number(r.fixture_id)));
  }));
  for (const uid of Object.keys(favoritesByUser)) {
    console.log(`${LP} user=${uid.slice(0, 8)} favoritos=[${[...favoritesByUser[uid]].join(',')}]`);
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
    console.log(`${LP} bundle fid=${bundle.fixtureId} (typeof=${typeof bundle.fixtureId}) → suscriptores con este fixture en favoritos: ${subsWithThisFav}/${subs.length}`);

    await Promise.allSettled(subs.map(async (row) => {
      const favs = favoritesByUser[row.user_id] || new Set();
      if (!favs.has(bundle.fixtureId)) {
        skippedNoFav++;
        console.log(`${LP} GUARD favoritos: user=${row.user_id.slice(0, 8)} NO tiene fid=${bundle.fixtureId} en favoritos=[${[...favs].join(',')}] ⇒ skip`);
        return;
      }
      bundleHadSubscriberInFav = true;

      const deviceSubs = toSubArray(row.subscription);
      console.log(`${LP} user=${row.user_id.slice(0, 8)} tiene fid=${bundle.fixtureId} en favoritos → ${deviceSubs.length} dispositivo(s)`);
      if (deviceSubs.length === 0) {
        console.log(`${LP} GUARD subs: user=${row.user_id.slice(0, 8)} subscription vacía/no parseable ⇒ no hay dispositivo`);
      }
      await Promise.allSettled(deviceSubs.map(async (sub) => {
        if (!sub?.endpoint) {
          console.log(`${LP} GUARD endpoint: user=${row.user_id.slice(0, 8)} sub sin endpoint (keys=${sub ? Object.keys(sub).join(',') : 'null'}) ⇒ skip`);
          return;
        }
        attempted++;
        console.log(`${LP} → invocando sendPushNotification fid=${bundle.fixtureId} user=${row.user_id.slice(0, 8)} ep=…${String(sub.endpoint).slice(-12)} urgency=${bundle.urgent ? 'high' : 'normal'}`);
        const result = await sendPushNotification(
          sub,
          { title: bundle.title, body: bundle.body, tag: bundle.tag },
          { urgency: bundle.urgent ? 'high' : 'normal' },
        );
        if (result === true) { delivered++; bundleHadDelivery = true; }
        else if (result === 'expired') {
          expiredN++;
          if (!expiredByUser[row.user_id]) expiredByUser[row.user_id] = new Set();
          expiredByUser[row.user_id].add(sub.endpoint);
        } else failed++;
        console.log(`${LP} send fid=${bundle.fixtureId} user=${row.user_id.slice(0, 8)} ep=…${String(sub.endpoint).slice(-12)} → ${result}`);
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
  }
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
  console.log(`${LL} tick: today=${today} schedules(y/t/m)=${(schedYesterday?.kickoffTimes?.length||0)}/${(schedToday?.kickoffTimes?.length||0)}/${(schedTomorrow?.kickoffTimes?.length||0)} unión=${allKickoffs.length}`);

  if (allKickoffs.length > 0) {
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
  const tracked = allLive.filter(m => ALL_LEAGUE_IDS.includes(m.league.id) && !YOUTH_RE.test(m.league.name || ''));
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

  const existingLive = (await redisGet(KEYS.liveStats(today))) || {};

  const needsEventsFetch = tracked.filter(m => {
    const fid = m.fixture.id;
    const totalGoals = (m.goals?.home || 0) + (m.goals?.away || 0);
    if (totalGoals === 0 || (m.events || []).length > 0) return false;
    const cached = existingLive[fid];
    if (cached?.goalScorers?.length > 0 && ((cached.goals?.home || 0) + (cached.goals?.away || 0)) === totalGoals) return false;
    return true;
  });

  if (needsEventsFetch.length > 0) {
    await Promise.all(needsEventsFetch.map(async (match) => {
      const fid = match.fixture.id;
      const data = await apiFetch(`/fixtures?id=${fid}`);
      apiCalls++;
      if (data?.[0]) {
        const full = data[0];
        const fullData = extractLiveStats(full, full.events || [], full.statistics || []);
        fullData.date = today;
        liveDetailsMap[fid] = fullData;
      }
    }));
  }

  const alreadyFetched = new Set(needsEventsFetch.map(m => m.fixture.id));
  const needsStatsFetchCandidates = tracked.filter(m => {
    const fid = m.fixture.id;
    if (alreadyFetched.has(fid)) return false;
    const elapsed = m.fixture?.status?.elapsed || 0;
    if (elapsed < 10) return false;
    // Si /fixtures?live=all YA trajo statistics inline (ligas con cobertura
    // completa), los corners de liveDetailsMap ya están frescos este tick →
    // no hace falta el endpoint dedicado.
    const hasStats = (m.statistics || []).length > 0;
    if (hasStats) return false;
    // BUG FIX (corner freeze): antes había `if (cached?.corners?.isReal) return
    // false` — saltaba el fetch PERMANENTEMENTE en cuanto los corners eran
    // reales una vez. Para ligas sin stats inline (BK Häcken/Allsvenskan,
    // Ucrania, China…) eso CONGELABA los corners en su primer valor real
    // (p.ej. 2): el partido seguía sumando corners (3, 4…) pero nunca se
    // re-consultaban las stats, así que ni el actual ni el baseline avanzaban
    // y no se generaba delta. Ahora SIEMPRE re-consultamos mientras el partido
    // siga vivo (el throttle de abajo evita llamadas duplicadas por solape de
    // crons). Re-fetchear /fixtures?id=X además trae los `events`, de donde
    // sale el jugador de la amarilla → arregla también el bug de tarjetas.
    return true;
  });

  // Throttle anti-solape: máx 1 stats-fetch por fixture cada 50s. Con el cron
  // de live cada 60s esto es ~1 fetch/tick (corners frescos sin retraso), pero
  // si dos ejecuciones se solapan (run largo + siguiente tick) NO duplicamos la
  // llamada a la API. TTL 50s < 60s para no saltarnos un tick legítimo.
  const STATS_FETCH_THROTTLE_SEC = 50;
  const needsStatsFetch = [];
  for (const m of needsStatsFetchCandidates) {
    const tkey = `live:statsfetch:${m.fixture.id}`;
    if (await alreadySent(tkey)) {
      console.log(`${LL} stats-fetch throttle: fid=${m.fixture.id} consultado hace <${STATS_FETCH_THROTTLE_SEC}s ⇒ skip este tick`);
      continue;
    }
    await markSentTTL(tkey, STATS_FETCH_THROTTLE_SEC);
    needsStatsFetch.push(m);
  }

  if (needsStatsFetch.length > 0) {
    await Promise.all(needsStatsFetch.map(async (match) => {
      const fid = match.fixture.id;
      // Paso 1: /fixtures?id=X — devuelve el partido completo. Para la mayoría
      // de ligas esto trae `statistics` inline. Para ligas exóticas (Ucrania
      // 333, China 169, Serbia 286, etc.) `statistics` viene vacío incluso aquí.
      const data = await apiFetch(`/fixtures?id=${fid}`);
      apiCalls++;
      let fullStats = (data?.[0]?.statistics) || [];
      let fullEvents = (data?.[0]?.events) || (match.events || []);
      let fullMatch = data?.[0] || match;

      // Paso 2 (fallback ligas exóticas): si statistics sigue vacío, vamos al
      // endpoint dedicado /fixtures/statistics?fixture=X que SÍ devuelve datos
      // para esas ligas. Es la diferencia clave — el endpoint principal
      // /fixtures incluye stats inline solo cuando la liga tiene "cobertura
      // completa" según el plan; el endpoint dedicado los expone siempre que
      // el proveedor de datos los tenga.
      if (fullStats.length === 0) {
        const dedicated = await apiFetch(`/fixtures/statistics?fixture=${fid}`);
        apiCalls++;
        if (Array.isArray(dedicated) && dedicated.length > 0) {
          fullStats = dedicated;
          console.log(`[live] stats rescue via /fixtures/statistics for fid=${fid} (${dedicated.length} teams)`);
        } else {
          console.log(`[live] no stats available for fid=${fid} after dedicated fetch — liga sin cobertura statistics`);
        }
      }

      const fullData = extractLiveStats(fullMatch, fullEvents, fullStats);
      fullData.date = today;
      liveDetailsMap[fid] = fullData;
    }));
  }

  // ── BUG FIX (retraso/perdida de corners por blip de la API) ──
  // API-Football alterna en ticks consecutivos del MISMO partido entre devolver
  // stats (isReal=true, p.ej. corners 0-4) y NO devolverlas (isReal=false → el
  // extractor pone 0-0). Si dejáramos el `now` en 0-0 cuando isReal=false:
  //   (a) se pierde el delta — un tick trae 0-4(real), el siguiente 0-0(no real)
  //       degrada el baseline, y cuando vuelve 0-4 ya no se detecta como nuevo;
  //   (b) el frontend parpadea a 0 y vuelve.
  // FIX: cuando los corners de este tick NO son reales, ARRASTRAR el último
  // valor real conocido (de existingLive). Así el `now` nunca retrocede a 0 por
  // un blip y el baseline solo avanza con valores reales. Mutamos liveDetailsMap
  // aquí para que TODO lo de abajo (push, merge, fixtureStats, Pusher) use el
  // valor arrastrado de forma consistente.
  for (const [fid, data] of Object.entries(liveDetailsMap)) {
    if (data?.corners && data.corners.isReal === false) {
      const lastReal = existingLive[fid]?.corners;
      if (lastReal && lastReal.isReal && (lastReal.total || 0) > 0) {
        data.corners = { ...lastReal };
        console.log(`${LL} corners blip fid=${fid}: tick isReal=false → arrastro último real ${lastReal.home}-${lastReal.away} (total=${lastReal.total})`);
      }
    }
  }

  // Fire-and-forget pushes — 1 bundle por fixture/tick con TODOS los deltas
  // (goles, córners, amarillas, rojas/expulsiones, offside, sustituciones,
  // penalti, VAR). Anti-spam por agrupación en el propio bundle.
  console.log(`${LL} → sendBundledPushes: liveDetailsMap=${Object.keys(liveDetailsMap).length} existingLive=${Object.keys(existingLive).length}`);
  sendBundledPushes(liveDetailsMap, existingLive)
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

  const staleIds = Object.entries(existingLive)
    .filter(([fid, m]) => LIVE_STATUSES.includes(m.status?.short) && !currentLiveIds.has(Number(fid)))
    .map(([fid]) => Number(fid));

  if (staleIds.length > 0) {
    await Promise.all(staleIds.map(async (fid) => {
      const data = await apiFetch(`/fixtures?id=${fid}`);
      apiCalls++;
      if (data?.[0]) {
        const fresh = data[0];
        const freshStatus = fresh.fixture.status.short;
        if (FINISHED_STATUSES.includes(freshStatus)) {
          // Mismo fallback que en needsStatsFetch: si la respuesta principal
          // no trae statistics (ligas exóticas), pedirlo del endpoint dedicado.
          let statsArr = fresh.statistics || [];
          if (statsArr.length === 0) {
            const dedicated = await apiFetch(`/fixtures/statistics?fixture=${fid}`);
            apiCalls++;
            if (Array.isArray(dedicated) && dedicated.length > 0) {
              statsArr = dedicated;
              console.log(`[live:stale] stats rescue via /fixtures/statistics for fid=${fid}`);
            }
          }
          const fullStats = extractLiveStats(fresh, fresh.events || [], statsArr);
          fullStats.date = today;
          fullStats.savedAt = new Date().toISOString();
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
    const cachedFixtures = await redisGet(KEYS.fixtures(today));
    if (Array.isArray(cachedFixtures) && cachedFixtures.length > 0) {
      let changed = false;
      const updated = cachedFixtures.map(f => {
        const fid = f.fixture?.id;
        if (!fid || !allUpdatedIds.has(fid)) return f;
        const live = mergedLive[fid];
        if (!live?.status) return f;
        if (f.fixture.status.short === live.status.short &&
            (f.fixture.status.elapsed || 0) >= (live.status.elapsed || 0)) return f;
        changed = true;
        return { ...f, fixture: { ...f.fixture, status: live.status }, goals: live.goals || f.goals, score: live.score || f.score };
      });
      if (changed) redisSet(KEYS.fixtures(today), updated, TTL.fixtures).catch(() => {});
    }
  }

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
      corners: merged?.corners?.total > 0 ? merged.corners : (details?.corners || null),
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

  for (let i = 0; i < apiCalls; i++) await incrementApiCallCount();

  console.log(`${LL} ✓ done en ${Date.now() - t0}ms — tracked=${tracked.length} totalLive=${allLive.length} staleFixed=${staleFixedCount} apiCalls=${apiCalls}`);

  return {
    ok: true,
    liveCount: tracked.length,
    totalLive: allLive.length,
    staleFixed: staleFixedCount,
    apiCalls,
  };
}
