/**
 * GET /api/cron/finalize
 * Two-pass finalizer that persists match results and closes prediction rows.
 *
 * Pass 1 — Redis (fast, no API calls):
 *   If liveStats is in Redis, flush any newly-finished matches to match_results
 *   and update match_predictions. Runs well within the 2h Redis TTL window.
 *
 * Pass 2 — Supabase fallback (always runs after Pass 1):
 *   Finds match_predictions rows that are still unfinalized but whose kickoff
 *   was > 2h ago. Cross-references match_results first (free), then falls back
 *   to an API call per missing fixture. This guarantees results are persisted
 *   even when Redis has already expired (e.g., 3 AM cron runs).
 *
 * Run schedule: 3 AM and 4 AM Spain CEST via cron-job.org.
 */

import { redisGet, KEYS } from '../../../../lib/redis';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const API_HOST = 'v3.football.api-sports.io';

function verifyCronAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  const internal = request.headers.get('x-internal-trigger') === 'true';
  return secret === process.env.CRON_SECRET || internal || process.env.NODE_ENV !== 'production';
}

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

  // Tarjetas totales (yellow + red, ambos equipos). Si la stat es null, fallback a contar eventos Card.
  const yh = getStat(homeStats, 'Yellow Cards');
  const ya = getStat(awayStats, 'Yellow Cards');
  const rh = getStat(homeStats, 'Red Cards');
  const ra = getStat(awayStats, 'Red Cards');
  const fromStats = [yh, ya, rh, ra].some(v => v != null);
  const totalCards = fromStats
    ? (yh || 0) + (ya || 0) + (rh || 0) + (ra || 0)
    : cardEvents.length;

  // Minutos de gol y minuto del primer gol
  const goalMinutes = goalEvents
    .map(e => (e.time?.elapsed != null ? e.time.elapsed + (e.time.extra || 0) : null))
    .filter(m => m != null)
    .sort((a, b) => a - b);
  const firstGoalMinute = goalMinutes.length > 0 ? goalMinutes[0] : null;

  // Goleadores reales en formato compacto
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

export async function GET(request) {
  if (!verifyCronAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) return Response.json({ error: 'No API key' }, { status: 500 });

  const today     = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  let pass1 = 0, pass2 = 0, apiCalls = 0;

  // ── PASS 1: Redis (fast path) ─────────────────────────────────────
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

        for (const fid of toSave) {
          try {
            const match = await fetchFixture(fid, apiKey);
            apiCalls++;
            if (!match) continue;
            if (!FINISHED_STATUSES.includes(match.fixture?.status?.short)) continue;

            const r = extractResult(match);
            const { error } = await upsertMatchResult(fid, today, match, r);
            if (!error) {
              pass1++;
              await updatePrediction(fid, r).catch(() => {});
            }
          } catch (e) {
            console.error(`[FINALIZE P1] fixture ${fid}:`, e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('[FINALIZE P1] Redis read error:', e.message);
  }

  // ── PASS 2: Supabase fallback (runs regardless, catches Redis-expired matches) ──
  // Find unfinalized predictions whose kickoff was > 2h ago (match must be over)
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    const { data: unfinalized } = await supabaseAdmin
      .from('match_predictions')
      .select('fixture_id, date')
      .is('finalized_at', null)
      .lt('kickoff', twoHoursAgo)
      .in('date', [today, yesterday]);  // today + yesterday for late-finishing matches

    if (unfinalized?.length > 0) {
      const unfinalizedFids = unfinalized.map(r => r.fixture_id);

      // Check match_results first — free, no API call
      const { data: alreadyInResults } = await supabaseAdmin
        .from('match_results')
        .select('fixture_id, goals, score, status, corners, yellow_cards, red_cards, goal_scorers, card_events, date')
        .in('fixture_id', unfinalizedFids);

      const resultsMap = new Map((alreadyInResults || []).map(r => [r.fixture_id, r]));

      for (const { fixture_id: fid, date } of unfinalized) {
        try {
          const existing = resultsMap.get(fid);

          if (existing) {
            // Already in match_results — just close the prediction row
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
            await updatePrediction(fid, r).catch(() => {});
            pass2++;
          } else {
            // Not in match_results — fetch from API and save both tables
            const match = await fetchFixture(fid, apiKey);
            apiCalls++;
            if (!match) continue;
            if (!FINISHED_STATUSES.includes(match.fixture?.status?.short)) continue;

            const r = extractResult(match);
            const { error } = await upsertMatchResult(fid, date, match, r);
            if (!error) {
              pass2++;
              await updatePrediction(fid, r).catch(() => {});
            }
          }
        } catch (e) {
          console.error(`[FINALIZE P2] fixture ${fid}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[FINALIZE P2] Supabase query error:', e.message);
  }

  console.log(`[FINALIZE] pass1=${pass1} pass2=${pass2} apiCalls=${apiCalls}`);
  return Response.json({
    success: true,
    pass1Finalized: pass1,
    pass2Finalized: pass2,
    apiCalls,
    timestamp: new Date().toISOString(),
  });
}
