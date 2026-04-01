import { analyzeMatch, getFixtures } from '../../../../lib/api-football';
import { getCachedAnalysis, getAnalyzedFixtureIds, cacheAnalysis } from '../../../../lib/sanity-cache';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisGet, redisDel, redisSet, KEYS } from '../../../../lib/redis';

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

  // force=true: clear all existing analysis for the date before re-running
  if (force) {
    const { error: _errClear } = await supabaseAdmin.from('match_analysis').delete().eq('date', today);
    if (_errClear) console.error('[reanalyze:force-clear]', _errClear.message);
    await Promise.all([
      redisDel(`analysis:${today}`),
      redisDel(KEYS.fixtures(today)),
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

      for (let i = 0; i < fixtures.length; i += 5) {
        const batch = fixtures.slice(i, i + 5);
        await Promise.all(batch.map(async (fixture) => {
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
            const result = await analyzeMatch(fixture, { date: today, force });
            await cacheAnalysis(fid, { ...result, date: today });
            analyzed++;
            analyzedIds.push(fid);
            if (result.odds?.matchWinner) analyzedOdds[fid] = result.odds.matchWinner;
            analyzedData[fid] = buildSummary(result);
          } catch (e) {
            failed++;
            console.error(`[reanalyze] Failed ${fid}:`, e.message);
          }
          send({ type: 'progress', current: analyzed + skipped + failed, total, analyzed, skipped, failed, match: name });
        }));
      }

      const analysisCache = { globallyAnalyzed: analyzedIds, analyzedOdds, analyzedData };
      await redisSet(`analysis:${today}`, analysisCache, 12 * 3600).catch(() => {});

      send({ type: 'done', analyzed, skipped, failed, total });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
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
  };
}
