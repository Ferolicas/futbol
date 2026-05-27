// @ts-nocheck
/**
 * Job: baseball-live (MLB-only, MLB Stats API)
 *
 * Polling del estado EN VIVO de los juegos MLB del día desde la MLB Stats API
 * (gratis, sin límite de requests → sin el budget/throttle que api-baseball
 * obligaba). Por cada juego en vivo trae el estado pitch-by-pitch (inning,
 * conteo bolas/strikes/outs, corredores en base, pitcher/bateador, marcador),
 * lo persiste en baseball_match_results, lo emite por WebSocket ('baseball-live'
 * → 'update') para la UI en vivo, y manda push de carreras a favoritos.
 *
 * Payload: { date?: 'YYYY-MM-DD' }
 */
import {
  getMlbScheduleByDate, getMlbLiveGame, triggerEvent, bogotaToday,
  supabaseAdmin, redisGet, redisSet, sendPushNotification,
} from '../../shared.js';
import { mapPool } from '../../pool.js';

const SPORT_IDS = [1];
const PUSH_DEDUP_TTL_SEC = 1800; // 30 min — cubre dos ticks consecutivos

function bbDedupKey(fid, ...parts) { return `push:sent:bb:${fid}:${parts.join(':')}`; }
async function bbAlreadySent(key) {
  try { const v = await redisGet(key); return v !== null && v !== undefined; }
  catch { return false; }
}
async function bbMarkSent(key) { try { await redisSet(key, 1, PUSH_DEDUP_TTL_SEC); } catch {} }
function toSubArray(stored) {
  if (!stored) return [];
  const p = typeof stored === 'string' ? JSON.parse(stored) : stored;
  return Array.isArray(p) ? p : [p];
}

// Bundle de carreras: compara marcador actual (estado MLB) vs previo. Dedup por
// marcador exacto (monótono → nunca falso duplicado). Sin baseline → no notifica.
async function buildBaseballBundle(s, prev) {
  const fid = s.gamePk;
  const home = s.home?.name || '?';
  const away = s.away?.name || '?';
  const nH = s.home?.runs ?? 0;
  const nA = s.away?.runs ?? 0;
  const pH = prev?.home_score ?? null;
  const pA = prev?.away_score ?? null;
  if (pH == null || pA == null) return null;

  const lines = [];
  const sentKeys = [];
  if (nH > pH) {
    const k = bbDedupKey(fid, 'run', 'home', nH);
    if (!(await bbAlreadySent(k))) { const d = nH - pH; lines.push(`⚾ ${d === 1 ? 'Carrera' : `${d} carreras`} · ${home} (${nH}-${nA})`); sentKeys.push(k); }
  }
  if (nA > pA) {
    const k = bbDedupKey(fid, 'run', 'away', nA);
    if (!(await bbAlreadySent(k))) { const d = nA - pA; lines.push(`⚾ ${d === 1 ? 'Carrera' : `${d} carreras`} · ${away} (${nH}-${nA})`); sentKeys.push(k); }
  }
  if (lines.length === 0) return null;

  const arrow = s.inningHalf === 'Top' ? '↑' : s.inningHalf === 'Bottom' ? '↓' : '';
  const inningTxt = s.inning ? ` · ${arrow}${s.inning}` : '';
  return {
    fixtureId: Number(fid),
    title: `${home} ${nH}-${nA} ${away}${inningTxt}`,
    body: lines.join('\n'),
    tag: `bb-live-${fid}-${nH}-${nA}`,
    sentKeys,
  };
}

async function sendBaseballPushes(states, prevMap) {
  const LP = '[baseball-live:push]';
  const bundles = [];
  for (const s of states) {
    const b = await buildBaseballBundle(s, prevMap[Number(s.gamePk)]);
    if (b) bundles.push(b);
  }
  if (bundles.length === 0) return;

  const { data: subs, error: subsErr } = await supabaseAdmin.from('push_subscriptions').select('user_id, subscription');
  if (subsErr) { console.error(`${LP} push_subscriptions:`, subsErr.message || subsErr); return; }
  if (!subs?.length) { for (const b of bundles) await Promise.all(b.sentKeys.map(bbMarkSent)); return; }

  const favByUser = {};
  await Promise.all(subs.map(async (row) => {
    if (favByUser[row.user_id] !== undefined) return;
    const { data: favRows } = await supabaseAdmin.from('baseball_user_favorites').select('fixture_id').eq('user_id', row.user_id);
    favByUser[row.user_id] = new Set((favRows || []).map(r => Number(r.fixture_id)));
  }));

  const expiredByUser = {};
  let delivered = 0, failed = 0, skippedNoFav = 0;
  for (const bundle of bundles) {
    let hadDelivery = false, hadSubInFav = false;
    await Promise.allSettled(subs.map(async (row) => {
      const favs = favByUser[row.user_id] || new Set();
      if (!favs.has(bundle.fixtureId)) { skippedNoFav++; return; }
      hadSubInFav = true;
      await Promise.allSettled(toSubArray(row.subscription).map(async (sub) => {
        if (!sub?.endpoint) return;
        const r = await sendPushNotification(sub, { title: bundle.title, body: bundle.body, tag: bundle.tag }, { urgency: 'high' });
        if (r === true) { delivered++; hadDelivery = true; }
        else if (r === 'expired') { (expiredByUser[row.user_id] = expiredByUser[row.user_id] || new Set()).add(sub.endpoint); }
        else failed++;
      }));
    }));
    if ((hadDelivery || !hadSubInFav) && bundle.sentKeys.length) await Promise.all(bundle.sentKeys.map(bbMarkSent));
  }
  console.log(`${LP} ok=${delivered} fallo=${failed} sinFav=${skippedNoFav}`);

  const usersExpired = Object.keys(expiredByUser);
  if (usersExpired.length === 0) return;
  await Promise.allSettled(usersExpired.map(async (userId) => {
    try {
      const exp = expiredByUser[userId];
      const { data: row } = await supabaseAdmin.from('push_subscriptions').select('subscription').eq('user_id', userId).maybeSingle();
      if (!row) return;
      const remaining = toSubArray(row.subscription).filter(s => !exp.has(s?.endpoint));
      if (remaining.length === 0) await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', userId);
      else await supabaseAdmin.from('push_subscriptions').update({ subscription: remaining }).eq('user_id', userId);
    } catch (e) { console.error(`${LP} purge`, userId, e.message); }
  }));
}

export async function runBaseballLive(payload = {}) {
  const today = payload.date || bogotaToday();

  // 1) Schedule del día (ligero) — ver qué juegos hay y cuáles en vivo.
  let games = [];
  for (const sid of SPORT_IDS) {
    try { games.push(...await getMlbScheduleByDate(today, sid)); }
    catch (e) { console.warn(`[baseball-live] schedule sportId=${sid}: ${e.message}`); }
  }
  if (games.length === 0) return { ok: true, skipped: true, reason: 'no games today' };

  const liveGames = games.filter(g => g.isLive);
  if (liveGames.length === 0) {
    // No hay nada en vivo → emitimos los marcadores del schedule (para cerrar
    // finales en la UI) y salimos sin pedir el feed detallado.
    try {
      await triggerEvent('baseball-live', 'update', {
        date: today,
        games: games.map(g => ({ gamePk: g.gamePk, status: g.status, isFinal: g.isFinal, inning: g.inning,
          home: { name: g.home.name, runs: g.home.score }, away: { name: g.away.name, runs: g.away.score } })),
        timestamp: new Date().toISOString(),
      });
    } catch {}
    return { ok: true, skipped: true, reason: 'no live games', total: games.length };
  }

  // 2) Estado detallado en vivo de cada juego (MLB Stats API gratis → sin throttle).
  const detailed = await mapPool(liveGames, 6, async (g) => {
    try { return await getMlbLiveGame(g.gamePk); } catch (e) { console.warn(`[baseball-live] liveGame ${g.gamePk}: ${e.message}`); return null; }
  });
  const states = detailed.filter(r => r.ok && r.value).map(r => r.value);
  if (states.length === 0) return { ok: true, skipped: true, reason: 'no live state' };

  // 3) Baseline previo (para detectar carreras nuevas) ANTES de sobreescribir.
  const fids = states.map(s => Number(s.gamePk));
  let prevMap = {};
  const { data: prevRows } = await supabaseAdmin
    .from('baseball_match_results')
    .select('fixture_id, home_score, away_score, status')
    .in('fixture_id', fids);
  prevMap = Object.fromEntries((prevRows || []).map(r => [Number(r.fixture_id), r]));

  // 4) Persistir resultados (marcador + estado rico).
  await mapPool(states, 8, async (s) => {
    const { error } = await supabaseAdmin.from('baseball_match_results').upsert({
      fixture_id: s.gamePk,
      league_id: 1,
      date: today,
      // Códigos compatibles con el frontend (isLive: 'IN', isFinished: 'FT').
      status: s.isFinal ? 'FT' : (s.isLive ? 'IN' : 'NS'),
      inning: s.inning ?? null,
      inning_half: s.inningHalf ? s.inningHalf.toLowerCase() : null,
      home_score: s.home?.runs ?? null,
      away_score: s.away?.runs ?? null,
      home_hits: s.home?.hits ?? null,
      away_hits: s.away?.hits ?? null,
      home_errors: s.home?.errors ?? null,
      away_errors: s.away?.errors ?? null,
      innings: s.innings || null,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`upsert ${s.gamePk}: ${error.message || error}`);
    return s.gamePk;
  });

  // 5) WS para la UI en vivo (estado pitch-by-pitch completo).
  try {
    await triggerEvent('baseball-live', 'update', { date: today, games: states, timestamp: new Date().toISOString() });
  } catch (e) { console.error('[baseball-live] WS:', e.message); }

  // 6) Push de carreras a favoritos (best-effort).
  try { await sendBaseballPushes(states, prevMap); }
  catch (e) { console.error('[baseball-live:push] no fatal:', e.message); }

  console.log(`[baseball-live] live=${states.length}/${games.length} emitido WS + resultados`);
  return { ok: true, liveCount: states.length, total: games.length };
}
