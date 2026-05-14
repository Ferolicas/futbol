// @ts-nocheck
/**
 * Job: futbol-finalize
 * Port of /api/cron/finalize. Two-pass finalizer:
 *   Pass 1: Redis (fast, no API calls).
 *   Pass 2: Supabase fallback — finds unfinalized predictions older than 2h
 *           and reconciles them via match_results or API fetch.
 *
 * Payload: {} (none)
 */
import { redisGet, KEYS, supabaseAdmin, pgQuery } from '../../shared.js';
import { mapPool } from '../../pool.js';

const FINALIZE_CONCURRENCY = 10;

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const API_HOST = 'v3.football.api-sports.io';

async function fetchFixture(fid, apiKey) {
  const res = await fetch(`https://${API_HOST}/fixtures?id=${fid}`, {
    headers: { 'x-apisports-key': apiKey },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.response?.[0] || null;
}

function getStat(statsObj, name) {
  if (!statsObj?.statistics) return null;
  const s = statsObj.statistics.find(x => x.type === name);
  return s?.value ?? null;
}

function extractResult(match) {
  const homeId = match.teams.home.id;
  const awayId = match.teams.away.id;
  const homeStats = (match.statistics || []).find(s => s.team?.id === homeId);
  const awayStats = (match.statistics || []).find(s => s.team?.id === awayId);
  const goalEvents = (match.events || []).filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty');
  const cardEvents = (match.events || []).filter(e => e.type === 'Card');

  const hGoals = match.goals?.home ?? null;
  const aGoals = match.goals?.away ?? null;
  const hCorners = getStat(homeStats, 'Corner Kicks') || 0;
  const aCorners = getStat(awayStats, 'Corner Kicks') || 0;

  const yh = getStat(homeStats, 'Yellow Cards');
  const ya = getStat(awayStats, 'Yellow Cards');
  const rh = getStat(homeStats, 'Red Cards');
  const ra = getStat(awayStats, 'Red Cards');
  const fromStats = [yh, ya, rh, ra].some(v => v != null);
  const totalCards = fromStats
    ? (yh || 0) + (ya || 0) + (rh || 0) + (ra || 0)
    : cardEvents.length;

  const goalMinutes = goalEvents
    .map(e => (e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null))
    .filter(m => m != null)
    .sort((a, b) => a - b);
  const firstGoalMinute = goalMinutes.length > 0 ? goalMinutes[0] : null;

  const goalScorers = goalEvents.map(e => ({
    player_id: e.player?.id ?? null,
    name: e.player?.name ?? null,
    team_id: e.team?.id ?? null,
    minute: e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null,
    detail: e.detail || null,
  }));

  return {
    homeId, awayId, homeStats, awayStats,
    hGoals, aGoals,
    actualResult: hGoals === null ? null : hGoals > aGoals ? 'H' : hGoals < aGoals ? 'A' : 'D',
    actualBtts:   hGoals > 0 && aGoals > 0,
    totalGoals:   hGoals !== null ? hGoals + aGoals : null,
    totalCorners: hCorners + aCorners,
    hCorners, aCorners,
    totalCards,
    firstGoalMinute,
    goalMinutes,
    goalScorers,
    goalEvents, cardEvents,
  };
}

// Normaliza el string de API-Football: "M. Oliver, England" -> "M. Oliver".
// Algunos partidos llegan sin pais, otros con; sin normalizar se crean dos
// filas distintas en referee_stats. Tomamos el segmento antes de la coma.
function normalizeRefereeName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.split(',')[0]?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function upsertRefereeStats(match, r, dateStr) {
  const refName = normalizeRefereeName(match?.fixture?.referee);
  if (!refName) return;

  const yh = getStat(r.homeStats, 'Yellow Cards') || 0;
  const ya = getStat(r.awayStats, 'Yellow Cards') || 0;
  const rh = getStat(r.homeStats, 'Red Cards') || 0;
  const ra = getStat(r.awayStats, 'Red Cards') || 0;

  // Si no hay datos de tarjetas en statistics, no contabilizamos el partido
  // para el arbitro — preferimos perder una muestra antes que sesgar con ceros.
  if ([yh, ya, rh, ra].every(v => v === 0) && !r.totalCards) return;

  // pgQuery va al VPS Postgres (donde vive referee_stats). NO usar
  // supabaseAdmin.rpc — su .rpc apunta al Supabase real, no a pgAdmin.
  await pgQuery(
    'SELECT increment_referee_stats($1, $2, $3, $4::date)',
    [refName, yh + ya, rh + ra, dateStr]
  );
}

async function upsertMatchResult(fid, date, match, r) {
  return supabaseAdmin.from('match_results').upsert({
    fixture_id:  fid,
    date,
    league_id:   match.league.id,
    league_name: match.league.name,
    home_team:   { id: r.homeId, name: match.teams.home.name, logo: match.teams.home.logo },
    away_team:   { id: r.awayId, name: match.teams.away.name, logo: match.teams.away.logo },
    goals:       match.goals,
    score:       match.score,
    status:      match.fixture.status,
    corners:     { home: r.hCorners, away: r.aCorners, total: r.totalCorners },
    yellow_cards: {
      home: getStat(r.homeStats, 'Yellow Cards'),
      away: getStat(r.awayStats, 'Yellow Cards'),
    },
    red_cards: {
      home: getStat(r.homeStats, 'Red Cards'),
      away: getStat(r.awayStats, 'Red Cards'),
    },
    goal_scorers: r.goalEvents,
    card_events:  r.cardEvents,
    full_data:    match,
  }, { onConflict: 'fixture_id' });
}

async function updatePrediction(fid, r) {
  return supabaseAdmin.from('match_predictions').update({
    actual_home_goals:        r.hGoals,
    actual_away_goals:        r.aGoals,
    actual_result:            r.actualResult,
    actual_btts:              r.actualBtts,
    actual_total_goals:       r.totalGoals,
    actual_corners:           r.totalCorners || null,
    actual_total_cards:       r.totalCards ?? null,
    actual_first_goal_minute: r.firstGoalMinute ?? null,
    actual_goal_minutes:      r.goalMinutes && r.goalMinutes.length ? r.goalMinutes : null,
    actual_goal_scorers:      r.goalScorers && r.goalScorers.length ? r.goalScorers : null,
    finalized_at:             new Date().toISOString(),
  }).eq('fixture_id', fid);
}

export async function runFinalize(_payload = {}) {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) throw new Error('FOOTBALL_API_KEY not configured');

  const today     = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  let pass1 = 0, pass2 = 0;
  let apiCalls = 0;
  const errors = [];

  // ── PASS 1 — Redis (fast path, no API calls except for missing results)
  try {
    const liveStats = await redisGet(KEYS.liveStats(today));
    if (liveStats && typeof liveStats === 'object') {
      const finishedFids = Object.entries(liveStats)
        .filter(([, d]) => FINISHED_STATUSES.includes(d.status?.short))
        .map(([fid]) => Number(fid));

      if (finishedFids.length > 0) {
        const { data: existing } = await supabaseAdmin
          .from('match_results').select('fixture_id').in('fixture_id', finishedFids);
        const existingIds = new Set((existing || []).map(r => r.fixture_id));
        const toSave = finishedFids.filter(fid => !existingIds.has(fid));

        const p1Results = await mapPool(toSave, FINALIZE_CONCURRENCY, async (fid) => {
          const match = await fetchFixture(fid, apiKey);
          apiCalls++;
          if (!match) return { fid, status: 'no-match' };
          if (!FINISHED_STATUSES.includes(match.fixture?.status?.short)) return { fid, status: 'not-finished' };

          const r = extractResult(match);
          const { error } = await upsertMatchResult(fid, today, match, r);
          if (error) throw new Error(`upsert: ${error.message || error}`);
          // updatePrediction returns a Promise (async function) — safe to await
          try { await updatePrediction(fid, r); } catch (e) {
            console.warn(`[finalize P1] updatePrediction ${fid}:`, e.message);
          }
          // Acumular tarjetas al arbitro — fallo aqui NO debe romper el finalize
          try { await upsertRefereeStats(match, r, today); } catch (e) {
            console.warn(`[finalize P1] upsertRefereeStats ${fid}:`, e.message);
          }
          return { fid, status: 'finalized' };
        });

        p1Results.forEach((r, idx) => {
          if (!r.ok) {
            errors.push({ pass: 1, fixtureId: toSave[idx], error: r.error.message });
            console.error(`[job:futbol-finalize P1] fixture ${toSave[idx]}:`, r.error.message);
          } else if (r.value.status === 'finalized') {
            pass1++;
          }
        });
      }
    }
  } catch (e) {
    console.error('[job:futbol-finalize P1]', e.message);
    errors.push({ pass: 1, error: e.message });
  }

  // ── PASS 2 — Supabase fallback (catches Redis-expired matches)
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const { data: unfinalized } = await supabaseAdmin
      .from('match_predictions')
      .select('fixture_id, date')
      .is('finalized_at', null)
      .lt('kickoff', twoHoursAgo)
      .in('date', [today, yesterday]);

    if (unfinalized?.length > 0) {
      const unfinalizedFids = unfinalized.map(r => r.fixture_id);
      const { data: alreadyInResults } = await supabaseAdmin
        .from('match_results')
        .select('fixture_id, goals, score, status, corners, yellow_cards, red_cards, goal_scorers, card_events, date')
        .in('fixture_id', unfinalizedFids);

      const resultsMap = new Map((alreadyInResults || []).map(r => [r.fixture_id, r]));

      const p2Results = await mapPool(unfinalized, FINALIZE_CONCURRENCY, async ({ fixture_id: fid, date }) => {
        const existing = resultsMap.get(fid);

        if (existing) {
          const hGoals = existing.goals?.home ?? null;
          const aGoals = existing.goals?.away ?? null;
          const yc = existing.yellow_cards || {};
          const rc = existing.red_cards || {};
          const totalCards = (yc.home || 0) + (yc.away || 0) + (rc.home || 0) + (rc.away || 0);
          const scorers = Array.isArray(existing.goal_scorers) ? existing.goal_scorers : [];
          const goalMinutes = scorers
            .map(e => (e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null))
            .filter(m => m != null)
            .sort((a, b) => a - b);
          const goalScorers = scorers.map(e => ({
            player_id: e.player?.id ?? null,
            name: e.player?.name ?? null,
            team_id: e.team?.id ?? null,
            minute: e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null,
            detail: e.detail || null,
          }));
          const r = {
            hGoals, aGoals,
            actualResult: hGoals === null ? null : hGoals > aGoals ? 'H' : hGoals < aGoals ? 'A' : 'D',
            actualBtts:   hGoals > 0 && aGoals > 0,
            totalGoals:   hGoals !== null ? hGoals + aGoals : null,
            totalCorners: existing.corners?.total || null,
            totalCards:   totalCards || null,
            firstGoalMinute: goalMinutes[0] ?? null,
            goalMinutes,
            goalScorers,
          };
          await updatePrediction(fid, r);
          return { fid, status: 'finalized-from-results' };
        }

        const match = await fetchFixture(fid, apiKey);
        apiCalls++;
        if (!match) return { fid, status: 'no-match' };
        if (!FINISHED_STATUSES.includes(match.fixture?.status?.short)) return { fid, status: 'not-finished' };

        const r = extractResult(match);
        const { error } = await upsertMatchResult(fid, date, match, r);
        if (error) throw new Error(`upsert: ${error.message || error}`);
        try { await updatePrediction(fid, r); } catch (e) {
          console.warn(`[finalize P2] updatePrediction ${fid}:`, e.message);
        }
        try { await upsertRefereeStats(match, r, date); } catch (e) {
          console.warn(`[finalize P2] upsertRefereeStats ${fid}:`, e.message);
        }
        return { fid, status: 'finalized-from-api' };
      });

      p2Results.forEach((r, idx) => {
        if (!r.ok) {
          errors.push({ pass: 2, fixtureId: unfinalized[idx].fixture_id, error: r.error.message });
          console.error(`[job:futbol-finalize P2] fixture ${unfinalized[idx].fixture_id}:`, r.error.message);
        } else if (r.value.status?.startsWith('finalized')) {
          pass2++;
        }
      });
    }
  } catch (e) {
    console.error('[job:futbol-finalize P2]', e.message);
    errors.push({ pass: 2, error: e.message });
  }

  return { ok: true, pass1, pass2, apiCalls, errors: errors.length, concurrency: FINALIZE_CONCURRENCY };
}
