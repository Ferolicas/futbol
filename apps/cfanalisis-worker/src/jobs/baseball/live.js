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

// TTL de dedup por tipo de evento. La regla: TTL > período de polling (1 min)
// para que dos ticks consecutivos no re-emitan el mismo evento, pero ≤ hasta
// el siguiente evento del mismo tipo, para que cuando ocurra otro se envíe.
//   carrera        → 30 min (marcador monótono, dedup por marcador exacto)
//   home run       → 60 min
//   strikeout dorado → 30 min
//   cambio inning  → 120 min (entre top y bottom puede haber 10-20 min)
const PUSH_TTL = {
  run: 1800,
  hr: 3600,
  kGolden: 1800,
  inning: 7200,
};
// Cursor por gamePk con el mayor atBatIndex ya procesado para HR/K. TTL 24h
// (cubre extra innings + cualquier suspensión / postponed reanudada el día sig).
const PLAYS_CURSOR_TTL = 24 * 3600;

function bbDedupKey(fid, ...parts) { return `push:sent:bb:${fid}:${parts.join(':')}`; }
async function bbAlreadySent(key) {
  try { const v = await redisGet(key); return v !== null && v !== undefined; }
  catch { return false; }
}
async function bbMarkSent(key, ttlSec) { try { await redisSet(key, 1, ttlSec); } catch {} }

async function readPlaysCursor(fid) {
  try { const v = await redisGet(`bb:plays:cursor:${fid}`); return Number(v) || -1; }
  catch { return -1; }
}
async function writePlaysCursor(fid, atBatIndex) {
  try { await redisSet(`bb:plays:cursor:${fid}`, atBatIndex, PLAYS_CURSOR_TTL); } catch {}
}
function toSubArray(stored) {
  if (!stored) return [];
  const p = typeof stored === 'string' ? JSON.parse(stored) : stored;
  return Array.isArray(p) ? p : [p];
}

function inningArrow(half) {
  return half === 'Top' ? '↑' : half === 'Bottom' ? '↓' : '';
}

// Construye TODOS los bundles de un juego para este tick:
//   - run: cambio de marcador (estado actual vs DB previo). TTL 30 min.
//   - hr: jugadas nuevas con eventType=home_run. TTL 60 min.
//   - kGolden: strikeout que cierra inning (outsAfter=3) con corredores en base
//     antes del pitch. TTL 30 min.
//   - inning: cambio de (inning, inningHalf) vs DB previo. TTL 120 min.
//
// Devuelve { bundles: [{ title, body, tag, fixtureId, sentKeys:[{key,ttl}] }], cursorAdvanceTo }
// El job avanza el cursor SOLO si todos los pushes del juego se enviaron OK.
async function buildBaseballBundles(s, prev, cursor) {
  const fid = Number(s.gamePk);
  const home = s.home?.name || '?';
  const away = s.away?.name || '?';
  const nH = s.home?.runs ?? 0;
  const nA = s.away?.runs ?? 0;
  const arrow = inningArrow(s.inningHalf);
  const inningTxt = s.inning ? ` · ${arrow}${s.inning}` : '';
  const bundles = [];
  let maxAtBat = cursor;

  // ── 1) Carreras (marcador) ───────────────────────────────────────────
  if (prev?.home_score != null && prev?.away_score != null) {
    const lines = []; const sentKeys = [];
    if (nH > prev.home_score) {
      const k = bbDedupKey(fid, 'run', 'home', nH);
      if (!(await bbAlreadySent(k))) { const d = nH - prev.home_score; lines.push(`⚾ ${d === 1 ? 'Carrera' : `${d} carreras`} · ${home} (${nH}-${nA})`); sentKeys.push({ key: k, ttl: PUSH_TTL.run }); }
    }
    if (nA > prev.away_score) {
      const k = bbDedupKey(fid, 'run', 'away', nA);
      if (!(await bbAlreadySent(k))) { const d = nA - prev.away_score; lines.push(`⚾ ${d === 1 ? 'Carrera' : `${d} carreras`} · ${away} (${nH}-${nA})`); sentKeys.push({ key: k, ttl: PUSH_TTL.run }); }
    }
    if (lines.length) {
      bundles.push({
        fixtureId: fid,
        title: `${home} ${nH}-${nA} ${away}${inningTxt}`,
        body: lines.join('\n'),
        tag: `bb-live-${fid}-${nH}-${nA}`,
        sentKeys,
      });
    }
  }

  // ── 2) Jugadas nuevas (HR / K dorado) ────────────────────────────────
  // Se procesan SOLO plays con atBatIndex > cursor previo. Las plays vienen
  // ordenadas crono; recorremos y emitimos un push por evento de interés.
  for (const p of (s.recentPlays || [])) {
    if (p.atBatIndex == null || p.atBatIndex <= cursor) continue;
    if (p.atBatIndex > maxAtBat) maxAtBat = p.atBatIndex;

    const battingTeamName = p.battingTeam === 'home' ? home : away;
    const playInningTxt = p.inning ? ` · ${inningArrow(p.halfInning === 'top' ? 'Top' : 'Bottom')}${p.inning}` : '';
    const batterName = p.batter?.name ? ` · ${p.batter.name}` : '';

    // Home Run
    if (p.eventType === 'home_run') {
      const k = bbDedupKey(fid, 'hr', p.atBatIndex);
      if (!(await bbAlreadySent(k))) {
        bundles.push({
          fixtureId: fid,
          title: `💥 Home Run · ${battingTeamName} (${nH}-${nA})${playInningTxt}`,
          body: `${p.description || `Jonrón de ${battingTeamName}`}${batterName}`,
          tag: `bb-hr-${fid}-${p.atBatIndex}`,
          sentKeys: [{ key: k, ttl: PUSH_TTL.hr }],
        });
      }
    }

    // Strikeout dorado: el strikeout cierra la entrada (outsAfter=3) y había
    // corredor en base antes del pitch (ponche con runners on = "K dorado").
    if (p.eventType === 'strikeout' && p.outsAfter === 3 && p.runnersOnBaseBeforePlay > 0) {
      const k = bbDedupKey(fid, 'kgolden', p.atBatIndex);
      if (!(await bbAlreadySent(k))) {
        const pitcherName = s.currentPitcher?.name ? ` · ${s.currentPitcher.name}` : '';
        bundles.push({
          fixtureId: fid,
          title: `🥇 K dorado${playInningTxt} (${nH}-${nA})`,
          body: `${p.description || 'Strikeout cierra inning con corredores en base'}${pitcherName}`,
          tag: `bb-kgolden-${fid}-${p.atBatIndex}`,
          sentKeys: [{ key: k, ttl: PUSH_TTL.kGolden }],
        });
      }
    }
  }

  // ── 3) Cambio de inning ──────────────────────────────────────────────
  // Comparamos (inning, half) actual vs el guardado en baseball_match_results.
  // Top → Bottom o N → N+1. Dedup por (inning, half) exacto, TTL 2h.
  if (s.inning != null && s.inningHalf) {
    const prevInning = prev?.inning ?? null;
    const prevHalf = prev?.inning_half ?? null;
    const curHalfNorm = s.inningHalf.toLowerCase();
    const changed = prevInning != null && prevHalf != null && (prevInning !== s.inning || prevHalf !== curHalfNorm);
    if (changed) {
      const k = bbDedupKey(fid, 'inning', s.inning, curHalfNorm);
      if (!(await bbAlreadySent(k))) {
        bundles.push({
          fixtureId: fid,
          title: `🔄 Cambio de inning${inningTxt} · (${nH}-${nA})`,
          body: `${home} ${nH} - ${nA} ${away}`,
          tag: `bb-inning-${fid}-${s.inning}-${curHalfNorm}`,
          sentKeys: [{ key: k, ttl: PUSH_TTL.inning }],
        });
      }
    }
  }

  return { bundles, cursorAdvanceTo: maxAtBat };
}

async function sendBaseballPushes(states, prevMap) {
  const LP = '[baseball-live:push]';

  // Cursor por juego (atBatIndex de la última jugada procesada).
  const cursorByFid = {};
  await Promise.all(states.map(async (s) => {
    cursorByFid[Number(s.gamePk)] = await readPlaysCursor(Number(s.gamePk));
  }));

  const bundles = [];
  const advanceCursors = {};   // fid → maxAtBat propuesto (se persiste solo si delivery OK / no había sub)
  for (const s of states) {
    const fid = Number(s.gamePk);
    const { bundles: bs, cursorAdvanceTo } = await buildBaseballBundles(s, prevMap[fid], cursorByFid[fid]);
    if (cursorAdvanceTo > cursorByFid[fid]) advanceCursors[fid] = cursorAdvanceTo;
    bundles.push(...bs);
  }
  if (bundles.length === 0) {
    // Aún sin notificaciones, avanzamos el cursor: las plays vistas son nuevas
    // pero no produjeron eventos de interés (singles, fly outs, etc.).
    await Promise.all(Object.entries(advanceCursors).map(([fid, idx]) => writePlaysCursor(Number(fid), idx)));
    return;
  }

  const { data: subs, error: subsErr } = await supabaseAdmin.from('push_subscriptions').select('user_id, subscription');
  if (subsErr) { console.error(`${LP} push_subscriptions:`, subsErr.message || subsErr); return; }
  if (!subs?.length) {
    for (const b of bundles) await Promise.all(b.sentKeys.map(({ key, ttl }) => bbMarkSent(key, ttl)));
    await Promise.all(Object.entries(advanceCursors).map(([fid, idx]) => writePlaysCursor(Number(fid), idx)));
    return;
  }

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
    if ((hadDelivery || !hadSubInFav) && bundle.sentKeys.length) {
      await Promise.all(bundle.sentKeys.map(({ key, ttl }) => bbMarkSent(key, ttl)));
    }
  }
  console.log(`${LP} ok=${delivered} fallo=${failed} sinFav=${skippedNoFav} bundles=${bundles.length}`);

  // Avanza cursores tras procesar todos los bundles (independiente del éxito
  // de delivery: dedup individual ya protege; el cursor solo evita re-leer plays).
  await Promise.all(Object.entries(advanceCursors).map(([fid, idx]) => writePlaysCursor(Number(fid), idx)));

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
  // inning + inning_half necesarios para detectar cambio de inning (push notif).
  const { data: prevRows } = await supabaseAdmin
    .from('baseball_match_results')
    .select('fixture_id, home_score, away_score, status, inning, inning_half')
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
