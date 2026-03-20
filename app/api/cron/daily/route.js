import { getFixtures, getQuota, analyzeMatch } from '../../../../lib/api-football';
import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { getCachedFixturesRaw } from '../../../../lib/sanity-cache';
import { triggerEvent } from '../../../../lib/pusher';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Master daily batch: fetches fixtures + analyzes ALL matches inline
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');

  const isInternal = request.headers.get('x-internal-trigger') === 'true';
  if (!isInternal && secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const force = searchParams.get('force') === 'true';

  // Check if batch already completed today (skip if force=true)
  if (!force) {
    const batchFlag = await getFromSanity('appConfig', `dailyBatch-${today}`);
    if (batchFlag?.completed) {
      return Response.json({
        success: true,
        message: 'Batch already completed today',
        date: today,
        fixtureCount: batchFlag.fixtureCount || 0,
      });
    }
  }

  // Mark batch as started
  await saveToSanity('appConfig', `dailyBatch-${today}`, {
    date: today,
    started: true,
    completed: false,
    startedAt: new Date().toISOString(),
  });

  try {
    console.log(`[DAILY-BATCH] Starting for ${today}...`);

    // 1. Fetch all fixtures (1 API call, cached in Sanity)
    const result = await getFixtures(today);
    const fixtures = result.fixtures || [];
    console.log(`[DAILY-BATCH] ${fixtures.length} fixtures loaded`);

    if (fixtures.length === 0) {
      // Save empty schedule so live/lineups crons skip the day
      await saveToSanity('matchSchedule', today, {
        date: today,
        firstKickoff: null,
        lastExpectedEnd: null,
        kickoffTimes: [],
        fixtureCount: 0,
        createdAt: new Date().toISOString(),
      });
      await saveToSanity('appConfig', `dailyBatch-${today}`, {
        date: today, started: true, completed: true,
        fixtureCount: 0, completedAt: new Date().toISOString(),
      });
      return Response.json({ success: true, date: today, fixtureCount: 0, message: 'No fixtures today' });
    }

    // ===== PASO 5: Build and save matchSchedule =====
    const kickoffTimes = fixtures.map(f => {
      const kickoff = new Date(f.fixture.date).getTime();
      return {
        fixtureId: f.fixture.id,
        kickoff,
        expectedEnd: kickoff + 120 * 60 * 1000, // kickoff + 120 minutes
      };
    }).sort((a, b) => a.kickoff - b.kickoff);

    const firstKickoff = kickoffTimes[0].kickoff;
    const lastExpectedEnd = Math.max(...kickoffTimes.map(k => k.expectedEnd));

    await saveToSanity('matchSchedule', today, {
      date: today,
      firstKickoff,
      lastExpectedEnd,
      kickoffTimes,
      fixtureCount: fixtures.length,
      createdAt: new Date().toISOString(),
    });
    console.log(`[DAILY-BATCH] matchSchedule saved: ${fixtures.length} matches, first=${new Date(firstKickoff).toISOString()}, last end=${new Date(lastExpectedEnd).toISOString()}`);

    // 2. Analyze ALL matches inline in batches of 3
    const batchSize = 3;
    let totalAnalyzed = 0;
    let totalCached = 0;
    let totalFailed = 0;

    const allFixtures = await getCachedFixturesRaw(today) || fixtures;

    for (let offset = 0; offset < allFixtures.length; offset += batchSize) {
      const batch = allFixtures.slice(offset, offset + batchSize);
      console.log(`[DAILY-BATCH] Batch ${offset}/${allFixtures.length} (${batch.length} matches)`);

      await Promise.all(
        batch.map(async (fixture) => {
          try {
            const r = await analyzeMatch(fixture, { date: today, force });
            if (r.fromCache) totalCached++;
            else totalAnalyzed++;
          } catch (e) {
            totalFailed++;
            console.error(`[DAILY-BATCH] Failed ${fixture.fixture?.id}:`, e.message);
          }
        })
      );
    }

    // Mark complete
    await saveToSanity('appConfig', `dailyBatch-${today}`, {
      date: today, started: true, completed: true,
      fixtureCount: allFixtures.length,
      completedAt: new Date().toISOString(),
    });

    const quota = await getQuota();
    console.log(`[DAILY-BATCH] Done: ${totalAnalyzed} analyzed, ${totalCached} cached, ${totalFailed} failed`);

    // Notify open dashboards that analysis is ready
    await triggerEvent('analysis', 'batch-complete', {
      date: today,
      fixtureCount: allFixtures.length,
      analyzed: totalAnalyzed,
    });

    return Response.json({
      success: true,
      date: today,
      fixtureCount: allFixtures.length,
      analyzed: totalAnalyzed,
      cached: totalCached,
      failed: totalFailed,
      message: `Completed: ${totalAnalyzed} analyzed, ${totalCached} cached, ${totalFailed} failed`,
      schedule: { firstKickoff: new Date(firstKickoff).toISOString(), lastExpectedEnd: new Date(lastExpectedEnd).toISOString() },
      quota,
    });
  } catch (error) {
    console.error('[DAILY-BATCH] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
