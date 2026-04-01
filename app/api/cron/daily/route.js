/**
 * GET /api/cron/daily
 * Daily batch: fetch fixtures + analyze all matches.
 * Runs at 05:00 UTC (07:00 Spain). Uses Redis + Supabase only.
 */
import { getFixtures, analyzeMatch, getQuota } from '../../../../lib/api-football';
import { cacheAnalysis, cacheFixtures } from '../../../../lib/sanity-cache';
import { redisSet, redisDel, KEYS, TTL } from '../../../../lib/redis';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  const isInternal = request.headers.get('x-internal-trigger') === 'true';

  if (!isInternal && secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const force = searchParams.get('force') === 'true';

  // Check if already completed today
  if (!force) {
    const existing = await redisGet(`dailyBatch:${today}`);
    if (existing?.completed) {
      return Response.json({ success: true, message: 'Already completed', date: today, fixtureCount: existing.fixtureCount });
    }
  }

  console.log(`[daily] Starting for ${today}`);
  const startTime = Date.now();

  try {
    // 1. Fetch fixtures fresh from API-Football
    const { fixtures } = await getFixtures(today, { forceApi: true });
    if (!fixtures || fixtures.length === 0) {
      await redisSet(`dailyBatch:${today}`, { completed: true, fixtureCount: 0, date: today }, 86400);
      return Response.json({ success: true, date: today, fixtureCount: 0, message: 'No fixtures today' });
    }

    // 2. Cache fixtures in Redis + Supabase
    await cacheFixtures(today, fixtures);
    await redisSet(KEYS.fixtures(today), fixtures, TTL.fixtures || 7200);

    // 3. Build match schedule for live cron
    const kickoffTimes = fixtures.map(f => ({
      fixtureId: f.fixture.id,
      kickoff: new Date(f.fixture.date).getTime(),
      expectedEnd: new Date(f.fixture.date).getTime() + 120 * 60 * 1000,
    })).sort((a, b) => a.kickoff - b.kickoff);

    const scheduleData = {
      date: today,
      firstKickoff: kickoffTimes[0]?.kickoff || null,
      lastExpectedEnd: Math.max(...kickoffTimes.map(k => k.expectedEnd)),
      kickoffTimes,
      fixtureCount: fixtures.length,
      createdAt: new Date().toISOString(),
    };
    await redisSet(KEYS.schedule(today), scheduleData, TTL.schedule || 86400);

    // Also save to Supabase match_schedule
    const { error: _err1 } = await supabaseAdmin.from('match_schedule').upsert({
      date: today,
      kickoff_times: kickoffTimes,
      first_kickoff: scheduleData.firstKickoff,
      last_expected_end: scheduleData.lastExpectedEnd,
      fixture_count: fixtures.length,
    }, { onConflict: 'date' });
    if (_err1) console.error('[daily:schedule]', _err1.message);

    // 4. Analyze all fixtures in batches of 3
    let analyzed = 0, failed = 0, skipped = 0;
    const BATCH = 3;

    for (let i = 0; i < fixtures.length; i += BATCH) {
      const batch = fixtures.slice(i, i + BATCH);
      await Promise.all(batch.map(async (fixture) => {
        try {
          const result = await analyzeMatch(fixture, { date: today });
          if (!result || result.dataQuality === 'insufficient') { skipped++; return; }
          await cacheAnalysis(fixture.fixture.id, { ...result, date: today });
          analyzed++;
        } catch (e) {
          console.error(`[daily] fixture ${fixture.fixture.id}:`, e.message);
          failed++;
        }
      }));
      if (i + BATCH < fixtures.length) await new Promise(r => setTimeout(r, 300));
    }

    // 5. Invalidate analysis Redis cache
    await redisDel(`analysis:${today}`);

    // 6. Mark batch complete
    const batchState = { completed: true, fixtureCount: fixtures.length, analyzed, failed, skipped, date: today, completedAt: new Date().toISOString() };
    await redisSet(`dailyBatch:${today}`, batchState, 86400);

    const quota = await getQuota();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[daily] Done in ${duration}s — analyzed:${analyzed} failed:${failed} skipped:${skipped}`);

    return Response.json({ success: true, date: today, fixtureCount: fixtures.length, analyzed, failed, skipped, duration: `${duration}s`, quota });
  } catch (e) {
    console.error('[daily]', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

async function redisGet(key) {
  const { redisGet: rg } = await import('../../../../lib/redis');
  return rg(key);
}
