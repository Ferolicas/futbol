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

function extractLiveStats(match, events, stats) {
  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;
  const homeStats = (stats || []).find(s => s.team?.id === homeId);
  const awayStats = (stats || []).find(s => s.team?.id === awayId);

  const getVal = (teamStats, type) => {
    const stat = (teamStats?.statistics || []).find(s => s.type === type);
    return stat?.value || 0;
  };

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

  const hCorners = getVal(homeStats, 'Corner Kicks');
  const aCorners = getVal(awayStats, 'Corner Kicks');
  const hYellow = getVal(homeStats, 'Yellow Cards') || cardEvents.filter(e => e.teamId === homeId && e.type === 'Yellow Card').length;
  const aYellow = getVal(awayStats, 'Yellow Cards') || cardEvents.filter(e => e.teamId === awayId && e.type === 'Yellow Card').length;
  const hRed = getVal(homeStats, 'Red Cards') || cardEvents.filter(e => e.teamId === homeId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;
  const aRed = getVal(awayStats, 'Red Cards') || cardEvents.filter(e => e.teamId === awayId && (e.type === 'Red Card' || e.type === 'Second Yellow card')).length;
  // Stage notif: offsides — vienen de stats por equipo (no de events).
  // Algunas ligas menores no reportan offsides; default 0.
  const hOffsides = getVal(homeStats, 'Offsides');
  const aOffsides = getVal(awayStats, 'Offsides');

  return {
    fixtureId: match.fixture.id,
    status: match.fixture.status,
    goals: match.goals,
    score: match.score,
    homeTeam: { id: homeId, name: match.teams.home.name },
    awayTeam: { id: awayId, name: match.teams.away.name },
    corners: { home: hCorners, away: aCorners, total: hCorners + aCorners },
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
//   ⚽ Goles · 🚩 córners · 🟨 amarillas · 🟥 rojas · 🚫 offside ·
//   🔄 sustituciones · 🅿️ penalti · 📺 VAR (gol anulado / penalti anulado)
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

function buildEventBundle(fid, data, prev) {
  const home = data.homeTeam?.name || '?';
  const away = data.awayTeam?.name || '?';
  const minute = formatMinute(data.status);
  const lines = []; // emoji + texto, una línea por evento
  let urgent = false;

  // ── Goles ──
  const pHG = prev.goals?.home ?? 0, pAG = prev.goals?.away ?? 0;
  const nHG = data.goals?.home ?? 0, nAG = data.goals?.away ?? 0;
  if (nHG > pHG || nAG > pAG) {
    const last = data.goalScorers?.slice(-1)[0];
    const team = nHG > pHG ? home : away;
    lines.push(`⚽ ${team}${last?.player ? ` · ${last.player}` : ''}`);
    urgent = true;
  }

  // ── Córners ──
  const pHC = prev.corners?.home ?? 0, pAC = prev.corners?.away ?? 0;
  const nHC = data.corners?.home ?? 0, nAC = data.corners?.away ?? 0;
  if (nHC > pHC || nAC > pAC) {
    const team = nHC > pHC ? home : away;
    const inc = (nHC - pHC) + (nAC - pAC);
    lines.push(`🚩 Córner${inc > 1 ? ` x${inc}` : ''} · ${team}`);
  }

  // ── Amarillas ──
  const pHY = prev.yellowCards?.home ?? 0, pAY = prev.yellowCards?.away ?? 0;
  const nHY = data.yellowCards?.home ?? 0, nAY = data.yellowCards?.away ?? 0;
  if (nHY > pHY || nAY > pAY) {
    const team = nHY > pHY ? home : away;
    const lastCard = (data.cardEvents || [])
      .filter(e => e.type === 'Yellow Card' && e.teamName === team)
      .slice(-1)[0];
    lines.push(`🟨 ${team}${lastCard?.player ? ` · ${lastCard.player}` : ''}`);
  }

  // ── Rojas (incluye expulsiones por 2a amarilla) ──
  const pHR = prev.redCards?.home ?? 0, pAR = prev.redCards?.away ?? 0;
  const nHR = data.redCards?.home ?? 0, nAR = data.redCards?.away ?? 0;
  if (nHR > pHR || nAR > pAR) {
    const team = nHR > pHR ? home : away;
    const lastCard = (data.cardEvents || [])
      .filter(e => (e.type === 'Red Card' || e.type === 'Second Yellow card') && e.teamName === team)
      .slice(-1)[0];
    lines.push(`🟥 EXPULSADO · ${team}${lastCard?.player ? ` · ${lastCard.player}` : ''}`);
    urgent = true;
  }

  // ── Offsides ──
  const pHO = prev.offsides?.home ?? 0, pAO = prev.offsides?.away ?? 0;
  const nHO = data.offsides?.home ?? 0, nAO = data.offsides?.away ?? 0;
  if (nHO > pHO || nAO > pAO) {
    const team = nHO > pHO ? home : away;
    const inc = (nHO - pHO) + (nAO - pAO);
    lines.push(`🚫 Offside${inc > 1 ? ` x${inc}` : ''} · ${team}`);
  }

  // ── Sustituciones (lista) ──
  const prevSubKeys = new Set((prev.substitutions || []).map(evKey));
  const newSubs = (data.substitutions || []).filter(s => !prevSubKeys.has(evKey(s)));
  for (const s of newSubs) {
    const out = s.playerOut || '?';
    const inP = s.playerIn || '?';
    lines.push(`🔄 ${s.teamName || '?'} · ${out} → ${inP}`);
  }

  // ── Penaltis (lista — scored/missed/awarded) ──
  const prevPenKeys = new Set((prev.penaltyEvents || []).map(evKey));
  const newPens = (data.penaltyEvents || []).filter(p => !prevPenKeys.has(evKey(p)));
  for (const p of newPens) {
    const verb = p.kind === 'scored' ? 'convertido' : p.kind === 'missed' ? 'fallado' : 'señalado';
    lines.push(`🅿️ Penalti ${verb} · ${p.teamName || '?'}${p.player ? ` · ${p.player}` : ''}`);
    urgent = true;
  }

  // ── VAR (gol anulado / penalti anulado / decisión cambiada) ──
  const prevVarKeys = new Set((prev.varEvents || []).map(evKey));
  const newVars = (data.varEvents || []).filter(v => !prevVarKeys.has(evKey(v)));
  for (const v of newVars) {
    const det = v.detail || 'VAR';
    // Goles anulados son los más relevantes; los otros se reportan igual.
    lines.push(`📺 ${det} · ${v.teamName || '?'}${v.player ? ` · ${v.player}` : ''}`);
    urgent = true;
  }

  if (lines.length === 0) return null;

  // Título: marcador en vivo + minuto. Body: líneas concatenadas (max ~3 líneas
  // visibles en la notificación expandida; el resto se trunca silenciosamente).
  const title = `${home} ${nHG}-${nAG} ${away} · ${minute}'`;
  const body = lines.slice(0, 6).join('\n');
  // Tag estable por fixture+minuto+nEventos para que múltiples ticks no
  // sobrescriban notificaciones distintas. FCM reemplaza notifs con mismo tag.
  const tag = `live-${fid}-${minute}-${lines.length}`;
  return { fixtureId: Number(fid), title, body, tag, urgent };
}

async function sendBundledPushes(liveDetailsMap, existingLive) {
  // 1. Construir bundles por fixture (solo cuando hay deltas y baseline previa)
  const bundles = [];
  for (const [fid, data] of Object.entries(liveDetailsMap)) {
    const prev = existingLive[fid];
    if (!prev) continue; // sin baseline → no notificamos el estado inicial
    const bundle = buildEventBundle(fid, data, prev);
    if (bundle) bundles.push(bundle);
  }
  if (bundles.length === 0) return;

  // 2. Cargar suscripciones + favoritos por usuario una sola vez
  const { data: subs } = await supabaseAdmin
    .from('push_subscriptions')
    .select('user_id, subscription');
  if (!subs?.length) return;

  const favoritesByUser = {};
  await Promise.all(subs.map(async (row) => {
    if (favoritesByUser[row.user_id] !== undefined) return;
    const { data: favRows } = await supabaseAdmin
      .from('user_favorites')
      .select('fixture_id')
      .eq('user_id', row.user_id);
    favoritesByUser[row.user_id] = new Set((favRows || []).map(r => Number(r.fixture_id)));
  }));

  // 3. Enviar — recolectar endpoints expirados para purga al final
  const expiredByUser = {};
  for (const bundle of bundles) {
    await Promise.allSettled(subs.map(async (row) => {
      const favs = favoritesByUser[row.user_id] || new Set();
      if (!favs.has(bundle.fixtureId)) return;

      const deviceSubs = toSubArray(row.subscription);
      await Promise.allSettled(deviceSubs.map(async (sub) => {
        if (!sub?.endpoint) return;
        const result = await sendPushNotification(
          sub,
          { title: bundle.title, body: bundle.body, tag: bundle.tag },
          { urgency: bundle.urgent ? 'high' : 'normal' },
        );
        if (result === 'expired') {
          if (!expiredByUser[row.user_id]) expiredByUser[row.user_id] = new Set();
          expiredByUser[row.user_id].add(sub.endpoint);
        }
      }));
    }));
  }

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
  const now = Date.now();

  // Smart schedule check — skip if no matches active
  let schedule = await redisGet(KEYS.schedule(today));
  if (!schedule) schedule = await getMatchSchedule(today).catch(() => null);

  if (schedule) {
    const firstKickoff = schedule.firstKickoff ? Number(schedule.firstKickoff) : null;
    const lastExpectedEnd = schedule.lastExpectedEnd ? Number(schedule.lastExpectedEnd) : null;

    if (!schedule.kickoffTimes || schedule.kickoffTimes.length === 0) {
      return { ok: true, skipped: true, reason: 'no fixtures scheduled today', apiCalls: 0 };
    }
    if (firstKickoff && now < firstKickoff - 5 * 60 * 1000) {
      return { ok: true, skipped: true, reason: 'before first kickoff', apiCalls: 0 };
    }
    if (lastExpectedEnd && now > lastExpectedEnd + 30 * 60 * 1000) {
      return { ok: true, skipped: true, reason: 'after last expected end + 30min', apiCalls: 0 };
    }

    const hasActiveMatch = schedule.kickoffTimes.some(m => {
      const kickoff = Number(m.kickoff);
      const expectedEnd = Number(m.expectedEnd);
      return now >= kickoff - 5 * 60 * 1000 && now <= expectedEnd;
    });

    if (!hasActiveMatch) {
      const lastRun = await redisGet('live-cron:last-run');
      if (lastRun && Number(lastRun) > now - 10 * 60 * 1000) {
        return { ok: true, skipped: true, reason: 'no active matches in window', apiCalls: 0 };
      }
    }
  }

  await redisSet('live-cron:last-run', String(now), 600);

  const allLive = await apiFetch('/fixtures?live=all');
  let apiCalls = 1;
  if (!allLive) {
    // null = cuota agotada, error de la API o red caída. apiFetch ya lo logueó
    // a stdout (visible en pm2 logs). NO lanzamos: con attempts:1 el cron del
    // minuto siguiente reintenta solo, y un throw aquí dispararía alerta de
    // Telegram cada minuto mientras dure la cuota agotada.
    return { ok: true, skipped: true, reason: 'API sin datos (cuota agotada / error API / red)' };
  }

  const YOUTH_RE = /\bU-?1[2-9]\b|\bU-?2[0-3]\b|\bunder[ -]?(1[2-9]|2[0-3])\b|\byouth\b|\bjunior\b|\bsub-?(1[2-9]|2[0-3])\b/i;
  const tracked = allLive.filter(m => ALL_LEAGUE_IDS.includes(m.league.id) && !YOUTH_RE.test(m.league.name || ''));

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
  const needsStatsFetch = tracked.filter(m => {
    const fid = m.fixture.id;
    if (alreadyFetched.has(fid)) return false;
    const elapsed = m.fixture?.status?.elapsed || 0;
    if (elapsed < 10) return false;
    const hasStats = (m.statistics || []).length > 0;
    if (hasStats) return false;
    const cached = existingLive[fid];
    if (cached?.corners?.total > 0) return false;
    return true;
  });

  if (needsStatsFetch.length > 0) {
    await Promise.all(needsStatsFetch.map(async (match) => {
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

  // Fire-and-forget pushes — 1 bundle por fixture/tick con TODOS los deltas
  // (goles, córners, amarillas, rojas/expulsiones, offside, sustituciones,
  // penalti, VAR). Anti-spam por agrupación en el propio bundle.
  sendBundledPushes(liveDetailsMap, existingLive)
    .catch(err => console.error('[live:bundled-pushes]', err.message));

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
          const fullStats = extractLiveStats(fresh, fresh.events || [], fresh.statistics || []);
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

  return {
    ok: true,
    liveCount: tracked.length,
    totalLive: allLive.length,
    staleFixed: staleFixedCount,
    apiCalls,
  };
}
