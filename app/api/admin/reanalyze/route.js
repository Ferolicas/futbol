import { analyzeMatch, getFixtures, fetchMatchStats } from '../../../../lib/api-football';
import { getCachedAnalysis, getAnalyzedFixtureIds, cacheAnalysis } from '../../../../lib/sanity-cache';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisGet, redisDel, redisSet, KEYS, TTL } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const OWNER_EMAIL = 'ferneyolicas@gmail.com';

export async function POST(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (user.email?.toLowerCase() !== OWNER_EMAIL) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const today = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const force = searchParams.get('force') === 'true';

  // force=true: clear ALL cached data for the date before re-running
  if (force) {
    const { error: _errClear } = await supabaseAdmin.from('match_analysis').delete().eq('date', today);
    if (_errClear) console.error('[reanalyze:force-clear]', _errClear.message);

    // Clear fixture + analysis + live stats caches
    const existingFixtures = await redisGet(KEYS.fixtures(today));
    const fidsToClear = Array.isArray(existingFixtures)
      ? existingFixtures.map(f => f.fixture?.id).filter(Boolean)
      : [];

    await Promise.all([
      redisDel(`analysis:${today}`),
      redisDel(KEYS.fixtures(today)),
      redisDel(KEYS.liveStats(today)),
      ...fidsToClear.map(fid => redisDel(KEYS.fixtureStats(fid))),
      ...fidsToClear.map(fid => redisDel(`analysis:fixture:${fid}`)),
    ]);
  }

  // Fetch FRESH fixtures from API-Football
  let fixtures = null;
  try {
    const result = await getFixtures(today, { forceApi: true });
    fixtures = result.fixtures || [];
  } catch {}

  if (!fixtures || fixtures.length === 0) {
    const redisFixtures = await redisGet(KEYS.fixtures(today));
    if (Array.isArray(redisFixtures) && redisFixtures.length > 0) {
      fixtures = redisFixtures;
    }
  }

  if (!fixtures || fixtures.length === 0) {
    return Response.json({ success: true, analyzed: 0, message: 'No fixtures for this date' });
  }

  await redisSet(KEYS.fixtures(today), fixtures, 48 * 3600).catch(() => {});

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let analyzed = 0, skipped = 0, failed = 0;
      const total = fixtures.length;
      const analyzedIds = [];
      const analyzedOdds = {};
      const analyzedData = {};

      send({ type: 'start', total });

      const analyzeOne = async (fixture) => {
        const fid = fixture.fixture?.id;
        const name = `${fixture.teams?.home?.name || '?'} vs ${fixture.teams?.away?.name || '?'}`;
        try {
          if (!force) {
            const existing = await getCachedAnalysis(fid, today);
            if (existing) {
              skipped++;
              analyzedIds.push(fid);
              if (existing.odds?.matchWinner) analyzedOdds[fid] = existing.odds.matchWinner;
              analyzedData[fid] = buildSummary(existing);
              send({ type: 'progress', current: analyzed + skipped + failed, total, analyzed, skipped, failed, match: name });
              return;
            }
          }
          let result;
          let lastErr;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              result = await analyzeMatch(fixture, { date: today, force });
              lastErr = null;
              break;
            } catch (e1) {
              lastErr = e1;
              console.warn(`[reanalyze] Attempt ${attempt + 1} failed for ${fid}: ${e1.message}`);
              await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
          }
          if (lastErr) throw lastErr;
          const a = result.analysis || result;
          analyzed++;
          analyzedIds.push(fid);
          if (a.odds?.matchWinner) analyzedOdds[fid] = a.odds.matchWinner;
          analyzedData[fid] = buildSummary(a);
        } catch (e) {
          failed++;
          console.error(`[reanalyze] Failed ${fid}:`, e.message);
        }
        send({ type: 'progress', current: analyzed + skipped + failed, total, analyzed, skipped, failed, match: name });
      };

      // Process in batches of 2 with 1.5s delay between batches to avoid API rate limits
      for (let i = 0; i < fixtures.length; i += 2) {
        const batch = fixtures.slice(i, i + 2);
        await Promise.all(batch.map(analyzeOne));
        if (i + 2 < fixtures.length) await new Promise(r => setTimeout(r, 1500));
      }

      const analysisCache = { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData };
      await redisSet(`analysis:${today}`, analysisCache, 12 * 3600).catch(() => {});

      // Re-fetch live stats (corners, cards, scorers) for finished matches
      const FINISHED = ['FT', 'AET', 'PEN'];
      const finishedFixtures = fixtures.filter(f => FINISHED.includes(f.fixture?.status?.short));
      if (finishedFixtures.length > 0) {
        send({ type: 'progress', current: total, total, analyzed, skipped, failed, match: 'Cargando estadísticas...' });
        const liveStatsMap = {};
        await Promise.all(finishedFixtures.map(async (f) => {
          const fid = f.fixture.id;
          try {
            const stats = await fetchMatchStats(fid);
            if (stats) {
              await redisSet(KEYS.fixtureStats(fid), stats, TTL.yesterday);
              liveStatsMap[fid] = stats;
            }
          } catch (e) {
            console.error(`[reanalyze:stats] ${fid}:`, e.message);
          }
        }));
        if (Object.keys(liveStatsMap).length > 0) {
          await redisSet(KEYS.liveStats(today), liveStatsMap, TTL.yesterday).catch(() => {});
        }
      }

      send({ type: 'done', analyzed, skipped, failed, total });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}

function compactLastFive(lastFive) {
  if (!Array.isArray(lastFive)) return [];
  return lastFive.map(m => {
    const e = m._enriched || {};
    return {
      r: e.result, s: e.score, gF: e.goalsFor, gA: e.goalsAgainst,
      op: e.opponentName, oL: e.opponentLogo,
      c: e.corners, y: e.yellowCards, rd: e.redCards,
    };
  });
}

function buildSummary(a) {
  return {
    fixtureId: a.fixtureId, homeTeam: a.homeTeam, awayTeam: a.awayTeam,
    homeLogo: a.homeLogo, awayLogo: a.awayLogo, homeId: a.homeId, awayId: a.awayId,
    league: a.league, leagueId: a.leagueId, leagueLogo: a.leagueLogo,
    kickoff: a.kickoff, status: a.status, goals: a.goals, odds: a.odds,
    combinada: a.combinada, calculatedProbabilities: a.calculatedProbabilities,
    homePosition: a.homePosition, awayPosition: a.awayPosition,
    homeLastFive: compactLastFive(a.homeLastFive),
    awayLastFive: compactLastFive(a.awayLastFive),
    playerHighlights: a.playerHighlights || null,
  };
}
