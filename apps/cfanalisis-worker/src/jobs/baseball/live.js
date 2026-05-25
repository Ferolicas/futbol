// @ts-nocheck
/**
 * Job: baseball-live
 * Port of /api/cron/baseball/live. Smart live updater with daily budget +
 * dynamic spacing. Runs every 5 minutes via cron-job.org → enqueue; the
 * handler itself decides whether to actually spend an API call.
 *
 * Payload: {}
 */
import { getBaseballLiveGames, getBaseballQuota, supabaseAdmin, redisGet, redisSet, sendPushNotification } from '../../shared.js';
import { mapPool } from '../../pool.js';

const LIVE_BUDGET = 30;
const SAFETY_RESERVE = 5;
const MIN_INTERVAL_MIN = 4;
const MAX_INTERVAL_MIN = 30;
const PRE_KICKOFF_BUFFER_MIN = 5;

// Fecha UTC con anticipo a "mañana" tras las 22 UTC — DEBE coincidir con la
// lógica de baseball-fixtures y baseball-analyze (los 3 jobs usan la misma
// función de fecha para que live encuentre el schedule que fixtures guardó).
// El nombre `bogotaDate` se conserva por uso interno; ya no es Bogotá.
const bogotaDate = () => {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const todayUTC    = now.toISOString().split('T')[0];
  const tomorrowUTC = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  return (utcHour >= 22 ? tomorrowUTC : todayUTC);
};
const callsKey = (d) => `baseball:live:calls:${d}`;
const lastCallKey = 'baseball:live:last_call_at';

// ────────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS — bundle por partido, dedup cross-tick por Redis.
//
// Mismo patrón que el live de fútbol (jobs/futbol/live.js) pero adaptado a la
// cadencia y a los eventos de baseball:
//
//   - EVENTO NOTIFICADO: carreras (runs). Es el equivalente al gol: dato REAL
//     (sabemos qué equipo anotó y el nuevo marcador) y de alta señal. La API
//     de baseball básica (/games) NO expone play-by-play con jugador, así que
//     NO inventamos eventos sin dato (al igual que fútbol descarta offsides).
//   - DEDUP: clave por marcador EXACTO. `push:sent:bb:{fid}:run:home:{score}`
//     solo se notifica una vez aunque el tick se repita. Como el marcador es
//     monótono creciente, una clave por valor nunca produce falso duplicado.
//   - TTL: 30 min. El live de baseball corre con espaciado dinámico (4-30 min
//     entre llamadas reales), mucho más lento que los 20s de fútbol, así que
//     el TTL de 90s de fútbol no sirve — usamos 1800s para cubrir el peor caso
//     de dos ticks consecutivos sin que la clave caduque entremedias.
//   - BUNDLE: si en un mismo tick ambos equipos anotaron, va 1 push con las 2
//     líneas en lugar de 2 pushes.
//   - BASELINE: si no tenemos estado previo del partido (primera vez que lo
//     vemos), NO notificamos — evita spamear el marcador inicial al arrancar.
//   - FAVORITOS: solo se notifica a usuarios que tienen el fixture en
//     baseball_user_favorites (mismo modelo que fútbol con user_favorites).
// ────────────────────────────────────────────────────────────────────────────
const PUSH_DEDUP_TTL_SEC = 1800; // 30 min — cadencia lenta del live de baseball

function bbDedupKey(fid, ...parts) {
  return `push:sent:bb:${fid}:${parts.join(':')}`;
}
async function bbAlreadySent(key) {
  try {
    const v = await redisGet(key);
    return v !== null && v !== undefined;
  } catch {
    return false; // FAIL OPEN — mejor un duplicado ocasional que perder el evento
  }
}
async function bbMarkSent(key) {
  try { await redisSet(key, 1, PUSH_DEDUP_TTL_SEC); } catch {}
}

function toSubArray(stored) {
  if (!stored) return [];
  const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Construye el bundle de carreras para un partido comparando el marcador
// actual (g) contra el previo (prev). Devuelve null si no hay deltas o no hay
// baseline previa. sentKeys: el caller las marca DESPUÉS de un envío OK.
async function buildBaseballBundle(g, prev) {
  const fid = g.id;
  const home = g.teams?.home?.name || '?';
  const away = g.teams?.away?.name || '?';
  const nH = g.scores?.home?.total ?? 0;
  const nA = g.scores?.away?.total ?? 0;
  const pH = prev?.home_score ?? null;
  const pA = prev?.away_score ?? null;

  // Sin baseline → no notificamos (estado inicial). Tampoco si el marcador
  // viene null (partido recién arrancado sin carreras todavía).
  if (pH == null || pA == null) return null;

  const lines = [];
  const sentKeys = [];

  if (nH > pH) {
    const k = bbDedupKey(fid, 'run', 'home', nH);
    if (!(await bbAlreadySent(k))) {
      const d = nH - pH;
      lines.push(`⚾ ${d === 1 ? 'Carrera' : `${d} carreras`} · ${home} (${nH}-${nA})`);
      sentKeys.push(k);
    }
  }
  if (nA > pA) {
    const k = bbDedupKey(fid, 'run', 'away', nA);
    if (!(await bbAlreadySent(k))) {
      const d = nA - pA;
      lines.push(`⚾ ${d === 1 ? 'Carrera' : `${d} carreras`} · ${away} (${nH}-${nA})`);
      sentKeys.push(k);
    }
  }

  if (lines.length === 0) return null;

  const inning = g.status?.inning ?? '';
  const half = (g.status?.long || '').toLowerCase();
  const arrow = half.includes('top') ? '↑' : half.includes('bottom') ? '↓' : '';
  const inningTxt = inning ? ` · ${arrow}${inning}` : '';
  const title = `${home} ${nH}-${nA} ${away}${inningTxt}`;
  const body = lines.join('\n');
  const tag = `bb-live-${fid}-${nH}-${nA}`;
  return { fixtureId: Number(fid), title, body, tag, sentKeys };
}

// Envía los bundles a los usuarios suscritos que tengan el fixture en favoritos.
// Marca las dedup keys solo si hubo entrega OK o si nadie tenía el fixture en
// favoritos (at-least-once: si todos los envíos fallan por un transient del
// push server, el siguiente tick reintenta).
async function sendBaseballPushes(liveGames, prevMap) {
  const LP = '[baseball-live:push]';
  const bundles = [];
  for (const g of liveGames) {
    const prev = prevMap[Number(g.id)];
    const bundle = await buildBaseballBundle(g, prev);
    if (bundle) bundles.push(bundle);
  }
  if (bundles.length === 0) return;
  for (const b of bundles) {
    console.log(`${LP} bundle fid=${b.fixtureId} "${b.title}" [${b.body.replace(/\n/g, ' | ')}]`);
  }

  const { data: subs, error: subsErr } = await supabaseAdmin
    .from('push_subscriptions')
    .select('user_id, subscription');
  if (subsErr) { console.error(`${LP} error leyendo push_subscriptions:`, subsErr.message || subsErr); return; }
  if (!subs?.length) {
    // Nadie suscrito — marcamos dedup igual para no reconstruir el bundle.
    for (const b of bundles) await Promise.all(b.sentKeys.map(bbMarkSent));
    return;
  }

  // Favoritos por usuario (una sola lectura por usuario).
  const favoritesByUser = {};
  await Promise.all(subs.map(async (row) => {
    if (favoritesByUser[row.user_id] !== undefined) return;
    const { data: favRows } = await supabaseAdmin
      .from('baseball_user_favorites')
      .select('fixture_id')
      .eq('user_id', row.user_id);
    favoritesByUser[row.user_id] = new Set((favRows || []).map(r => Number(r.fixture_id)));
  }));

  const expiredByUser = {};
  let attempted = 0, delivered = 0, failed = 0, expiredN = 0, skippedNoFav = 0;
  for (const bundle of bundles) {
    let bundleHadDelivery = false;
    let bundleHadSubscriberInFav = false;

    await Promise.allSettled(subs.map(async (row) => {
      const favs = favoritesByUser[row.user_id] || new Set();
      if (!favs.has(bundle.fixtureId)) { skippedNoFav++; return; }
      bundleHadSubscriberInFav = true;

      const deviceSubs = toSubArray(row.subscription);
      await Promise.allSettled(deviceSubs.map(async (sub) => {
        if (!sub?.endpoint) return;
        attempted++;
        const result = await sendPushNotification(
          sub,
          { title: bundle.title, body: bundle.body, tag: bundle.tag },
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

    const shouldMark = bundleHadDelivery || !bundleHadSubscriberInFav;
    if (shouldMark && bundle.sentKeys.length > 0) {
      await Promise.all(bundle.sentKeys.map(bbMarkSent));
    }
  }
  console.log(`${LP} resumen: intentos=${attempted} ok=${delivered} fallo=${failed} expirados=${expiredN} sinFav=${skippedNoFav}`);

  // Purga de endpoints expirados (410/404).
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
      console.error(`${LP} purge-expired`, userId, e.message);
    }
  }));
}

export async function runBaseballLive(payload = {}) {
  const today = payload.date || bogotaDate();
  const now = Date.now();

  const { data: scheduleRow } = await supabaseAdmin
    .from('baseball_match_schedule')
    .select('schedule')
    .eq('date', today)
    .maybeSingle();

  const schedule = scheduleRow?.schedule;
  if (!schedule || !schedule.firstKickoff || !schedule.lastExpectedEnd) {
    return { ok: true, skipped: true, reason: 'no schedule for today' };
  }

  const windowStart = schedule.firstKickoff - PRE_KICKOFF_BUFFER_MIN * 60 * 1000;
  const windowEnd = schedule.lastExpectedEnd;
  if (now < windowStart || now > windowEnd) {
    return { ok: true, skipped: true, reason: 'outside game window' };
  }

  const quota = await getBaseballQuota();
  if (quota.remaining <= SAFETY_RESERVE) {
    return { ok: true, skipped: true, reason: `quota too low (${quota.remaining})`, quota };
  }

  const liveCallsToday = Number((await redisGet(callsKey(today))) || 0);
  if (liveCallsToday >= LIVE_BUDGET) {
    return { ok: true, skipped: true, reason: `live budget exhausted (${liveCallsToday}/${LIVE_BUDGET})`, liveCallsToday };
  }

  const callsRemaining = Math.max(1, LIVE_BUDGET - liveCallsToday);
  const minutesUntilEnd = Math.max(1, (windowEnd - now) / 60000);
  let intervalMin = minutesUntilEnd / callsRemaining;
  intervalMin = Math.max(MIN_INTERVAL_MIN, Math.min(MAX_INTERVAL_MIN, intervalMin));
  const intervalMs = intervalMin * 60 * 1000;

  const lastCallAt = Number(await redisGet(lastCallKey)) || 0;
  const sinceLastMs = now - lastCallAt;
  if (lastCallAt && sinceLastMs < intervalMs) {
    const nextEligibleAt = lastCallAt + intervalMs;
    return {
      ok: true,
      skipped: true,
      reason: 'throttled',
      intervalMin: +intervalMin.toFixed(1),
      nextEligibleIn: Math.round((nextEligibleAt - now) / 1000),
      liveCallsToday,
      callsRemaining,
      quota,
    };
  }

  // getBaseballLiveGames usa apiCall, que lanza ante cuota agotada (429) o
  // error de API. Lo tratamos como skip — igual que los demás smart-skips de
  // este handler — para no disparar alerta de Telegram cada 5 min.
  let liveGames;
  try {
    liveGames = await getBaseballLiveGames();
  } catch (e) {
    return { ok: true, skipped: true, reason: `API sin datos (${e.message})` };
  }

  // Baseline para detectar carreras: leemos el marcador PREVIO de los partidos
  // en juego ANTES de sobreescribirlo con el upsert. prevMap[fid] = {home_score,
  // away_score, status}. Si un partido no está aquí (primera vez que lo vemos),
  // buildBaseballBundle no notifica → no spamea el marcador inicial.
  const liveFids = liveGames.map(g => Number(g.id));
  let prevMap = {};
  if (liveFids.length > 0) {
    const { data: prevRows } = await supabaseAdmin
      .from('baseball_match_results')
      .select('fixture_id, home_score, away_score, status')
      .in('fixture_id', liveFids);
    prevMap = Object.fromEntries((prevRows || []).map(r => [Number(r.fixture_id), r]));
  }

  const upsertResults = await mapPool(liveGames, 8, async (g) => {
    const fid = g.id;
    const homeScore = g.scores?.home?.total ?? null;
    const awayScore = g.scores?.away?.total ?? null;
    const homeHits = g.scores?.home?.hits ?? null;
    const awayHits = g.scores?.away?.hits ?? null;
    const homeErrors = g.scores?.home?.errors ?? null;
    const awayErrors = g.scores?.away?.errors ?? null;
    const innings = g.scores?.home?.innings || g.innings || null;

    const { error } = await supabaseAdmin.from('baseball_match_results').upsert({
      fixture_id: fid,
      league_id: g.league?.id,
      date: today,
      status: g.status?.short || g.status?.long,
      inning: g.status?.inning ?? null,
      inning_half: (g.status?.long || '').toLowerCase().includes('top') ? 'top' :
                   (g.status?.long || '').toLowerCase().includes('bottom') ? 'bottom' : null,
      home_score: homeScore,
      away_score: awayScore,
      home_hits: homeHits,
      away_hits: awayHits,
      home_errors: homeErrors,
      away_errors: awayErrors,
      innings,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`upsert: ${error.message || error}`);
    return fid;
  });
  const updated = upsertResults.filter(r => r.ok).length;
  const upsertFails = upsertResults.length - updated;
  if (upsertFails > 0) console.error(`[job:baseball-live] ${upsertFails}/${liveGames.length} upserts failed`);

  await redisSet(callsKey(today), liveCallsToday + 1, 36 * 3600);
  await redisSet(lastCallKey, now, 36 * 3600);

  // Push de carreras a favoritos (usa prevMap capturado antes del upsert).
  // No bloqueamos el resultado del job si el push falla — es best-effort.
  try {
    await sendBaseballPushes(liveGames, prevMap);
  } catch (e) {
    console.error('[baseball-live:push] error no fatal:', e.message);
  }

  return {
    ok: true,
    liveCount: liveGames.length,
    updated,
    intervalMin: +intervalMin.toFixed(1),
    liveCallsToday: liveCallsToday + 1,
    callsRemaining: callsRemaining - 1,
    quota: await getBaseballQuota(),
  };
}
