import { analyzeMatch, getFixtures, fetchMatchStats } from '../../../../lib/api-football';
import { getCachedAnalysis, getAnalyzedFixtureIds, cacheAnalysis, getAnalyzedMatchesFull } from '../../../../lib/sanity-cache';
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

  // force=true: clear Redis caches so fresh API data is fetched.
  // NOTE: Do NOT delete Supabase rows — if a match fails to re-analyze due to
  // rate limits, the old Supabase row stays as fallback. Re-analysis UPSERTs on success.
  if (force) {
    const existingFixtures = await redisGet(KEYS.fixtures(today));
    const fidsToClear = Array.isArray(existingFixtures)
      ? existingFixtures.map(f => f.fixture?.id).filter(Boolean)
      : [];

    await Promise.all([
      redisDel(`analysis:${today}`),
      redisDel(KEYS.fixtures(today)),
      // Do NOT delete liveStats or fixtureStats — they contain live score data
      // (corners, cards, scorers) that is independent of analysis. Deleting them
      // causes live matches to lose their stats on page refresh.
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

      // Process ONE match at a time — each analysis triggers 40-70+ API calls internally,
      // the rate limiter in api-football.js handles concurrency within each analysis.
      // Running 2+ matches in parallel doubles the request flood and causes 429 cascades.
      for (let i = 0; i < fixtures.length; i++) {
        await analyzeOne(fixtures[i]);
        if (i + 1 < fixtures.length) await new Promise(r => setTimeout(r, 1000));
      }

      // Merge fallback: fill in any failed fixtures from existing Supabase/Redis data
      // This guarantees 100% coverage — failed analyses keep their last known good data
      const failedFixtureIds = fixtures
        .map(f => f.fixture?.id)
        .filter(fid => fid != null && !analyzedIds.includes(fid));

      if (failedFixtureIds.length > 0) {
        send({ type: 'progress', current: total, total, analyzed, skipped, failed, match: `Recuperando ${failedFixtureIds.length} partidos sin analizar...` });
        try {
          const { analyzedOdds: existOdds, analyzedData: existData } = await getAnalyzedMatchesFull(failedFixtureIds);
          let merged = 0;
          for (const [fidStr, d] of Object.entries(existData)) {
            const fid = Number(fidStr);
            analyzedData[fid] = d;
            analyzedIds.push(fid);
            const odd = existOdds[fid] || d.odds?.matchWinner;
            if (odd) analyzedOdds[fid] = odd;
            merged++;
          }
          if (merged > 0) {
            send({ type: 'progress', current: total, total, analyzed, skipped: skipped + merged, failed: failed - merged, match: `${merged} partidos recuperados del caché` });
          }
        } catch (e) {
          console.error('[reanalyze] merge fallback failed:', e.message);
        }
      }

      const analysisCache = { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData };
      await redisSet(`analysis:${today}`, analysisCache, 12 * 3600).catch(() => {});

      // Re-fetch live stats (corners, cards, scorers) for finished matches
      const FINISHED = ['FT', 'AET', 'PEN'];
      const liveStatsMap = {};
      const finishedFixtures = fixtures.filter(f => FINISHED.includes(f.fixture?.status?.short));
      if (finishedFixtures.length > 0) {
        send({ type: 'progress', current: total, total, analyzed, skipped, failed, match: 'Cargando estadísticas...' });
        await Promise.all(finishedFixtures.map(async (f) => {
          const fid = f.fixture.id;
          try {
            const stats = await fetchMatchStats(fid);
            if (stats) {
              await redisSet(KEYS.fixtureStats(fid), stats, TTL.yesterday);
              liveStatsMap[fid] = stats;
              // Persist to Supabase permanently
              try {
                await supabaseAdmin.from('match_analysis')
                  .update({ live_stats: stats })
                  .eq('fixture_id', fid);
              } catch (e2) { console.error(`[reanalyze:stats] Supabase save ${fid}:`, e2.message); }
            }
          } catch (e) {
            console.error(`[reanalyze:stats] ${fid}:`, e.message);
          }
        }));
      }

      // Update live:{date} — merge fresh stats AND correct status for ALL fixtures
      // This fixes: match was 2H in live:{date}, now is FT from fresh API data
      const existingLive = await redisGet(KEYS.liveStats(today)) || {};
      const updatedLive = { ...existingLive };
      for (const f of fixtures) {
        const fid = f.fixture?.id;
        if (!fid) continue;
        const existing = updatedLive[fid];
        const freshStats = liveStatsMap?.[fid];
        if (freshStats) {
          // Finished match with full stats: use them, set correct FT status
          updatedLive[fid] = {
            ...freshStats,
            status: f.fixture.status,
            goals: f.goals,
            score: f.score,
          };
        } else if (existing) {
          // Update status/goals from fresh fixtures even without new stats
          updatedLive[fid] = {
            ...existing,
            status: f.fixture.status,
            goals: f.goals || existing.goals,
            score: f.score || existing.score,
          };
        }
      }
      await redisSet(KEYS.liveStats(today), updatedLive, TTL.yesterday).catch(() => {});

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
