/**
 * Finalize cron — runs every 5 minutes.
 * Detects matches that just finished (live → FT) and persists them to Supabase match_results.
 * This separates data persistence from the live score cron (which only updates Redis).
 */

import { redisGet, KEYS } from '../../../../lib/redis';
import { supabaseAdmin } from '../../../../lib/supabase';
import { ALL_LEAGUE_IDS } from '../../../../lib/leagues';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const API_HOST = 'v3.football.api-sports.io';

function verifyCronAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  const internal = request.headers.get('x-internal-trigger') === 'true';
  return secret === process.env.CRON_SECRET || internal || process.env.NODE_ENV !== 'production';
}

export async function GET(request) {
  if (!verifyCronAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const apiKey = process.env.FOOTBALL_API_KEY;
    if (!apiKey) return Response.json({ error: 'No API key' }, { status: 500 });

    // Get current live data from Redis
    const liveStats = await redisGet(KEYS.liveStats(today));
    if (!liveStats || typeof liveStats !== 'object') {
      return Response.json({ success: true, finalized: 0, reason: 'No live data in Redis', timestamp: new Date().toISOString() });
    }

    // Find matches that are in Redis as finished but not yet in Supabase
    const finishedFids = Object.entries(liveStats)
      .filter(([, data]) => FINISHED_STATUSES.includes(data.status?.short))
      .map(([fid]) => Number(fid));

    if (finishedFids.length === 0) {
      return Response.json({ success: true, finalized: 0, reason: 'No finished matches', timestamp: new Date().toISOString() });
    }

    // Check which are already in Supabase
    const { data: existing } = await supabaseAdmin
      .from('match_results')
      .select('fixture_id')
      .in('fixture_id', finishedFids);

    const existingIds = new Set((existing || []).map(r => r.fixture_id));
    const toFinalize = finishedFids.filter(fid => !existingIds.has(fid));

    if (toFinalize.length === 0) {
      return Response.json({ success: true, finalized: 0, reason: 'All finished matches already persisted', timestamp: new Date().toISOString() });
    }

    console.log(`[FINALIZE-CRON] Persisting ${toFinalize.length} newly finished matches`);

    let finalized = 0;
    let apiCalls = 0;

    for (const fid of toFinalize) {
      try {
        // Fetch full fixture data from API
        const res = await fetch(`https://${API_HOST}/fixtures?id=${fid}`, {
          headers: { 'x-apisports-key': apiKey },
          cache: 'no-store',
        });
        if (!res.ok) { console.error(`[FINALIZE-CRON] API error for fixture ${fid}:`, res.status); continue; }
        apiCalls++;

        const json = await res.json();
        const match = json.response?.[0];
        if (!match) continue;

        const homeId = match.teams.home.id;
        const awayId = match.teams.away.id;
        const homeStats = (match.statistics || []).find(s => s.team?.id === homeId);
        const awayStats = (match.statistics || []).find(s => s.team?.id === awayId);

        const getStat = (statsObj, name) => {
          if (!statsObj?.statistics) return null;
          const s = statsObj.statistics.find(x => x.type === name);
          return s?.value ?? null;
        };

        const goalEvents = (match.events || []).filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty');
        const cardEvents = (match.events || []).filter(e => e.type === 'Card');

        const { error } = await supabaseAdmin
          .from('match_results')
          .upsert({
            fixture_id: fid,
            date: today,
            league_id: match.league.id,
            league_name: match.league.name,
            home_team: { id: homeId, name: match.teams.home.name, logo: match.teams.home.logo },
            away_team: { id: awayId, name: match.teams.away.name, logo: match.teams.away.logo },
            goals: match.goals,
            score: match.score,
            status: match.fixture.status,
            corners: {
              home: getStat(homeStats, 'Corner Kicks'),
              away: getStat(awayStats, 'Corner Kicks'),
              total: (getStat(homeStats, 'Corner Kicks') || 0) + (getStat(awayStats, 'Corner Kicks') || 0),
            },
            yellow_cards: {
              home: getStat(homeStats, 'Yellow Cards'),
              away: getStat(awayStats, 'Yellow Cards'),
            },
            red_cards: {
              home: getStat(homeStats, 'Red Cards'),
              away: getStat(awayStats, 'Red Cards'),
            },
            goal_scorers: goalEvents,
            card_events: cardEvents,
            full_data: match,
          }, { onConflict: 'fixture_id' });

        if (error) {
          console.error(`[FINALIZE-CRON] Supabase error for fixture ${fid}:`, error.message);
        } else {
          finalized++;
        }
      } catch (err) {
        console.error(`[FINALIZE-CRON] Failed to finalize fixture ${fid}:`, err.message);
      }
    }

    return Response.json({
      success: true,
      finalized,
      apiCalls,
      total: toFinalize.length,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[FINALIZE-CRON] Error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
