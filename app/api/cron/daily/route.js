import { getFixtures, getQuota, analyzeMatch } from '../../../../lib/api-football';
import { getFromSanity, saveToSanity } from '../../../../lib/sanity';
import { getCachedFixturesRaw } from '../../../../lib/sanity-cache';
import { triggerEvent } from '../../../../lib/pusher';
import { redisSet, KEYS, TTL } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_RETRIES = 3;

// Master daily batch: fetches fixtures + analyzes ALL matches inline
// Supports automatic retry of failed matches on subsequent invocations.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');

  const isInternal = request.headers.get('x-internal-trigger') === 'true';
  if (!isInternal && secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const force = searchParams.get('force') === 'true';

  // ===== CHECK BATCH STATE =====
  const batchFlag = !force ? await getFromSanity('appConfig', `dailyBatch-${today}`) : null;

  // --- RETRY PATH: batch ran before but has failed IDs pending ---
  if (!force && batchFlag && batchFlag.failedIds?.length > 0 && !batchFlag.completed) {
    const currentRetry = (batchFlag.retryCount || 0) + 1;
    console.log(`[DAILY-BATCH] Retry #${currentRetry} for ${batchFlag.failedIds.length} failed fixtures on ${today}`);

    // If we've exhausted retries, mark completed and give up on those matches
    if (currentRetry > MAX_RETRIES) {
      console.error(`[DAILY-BATCH] GIVING UP on ${batchFlag.failedIds.length} fixtures after ${MAX_RETRIES} retries: ${JSON.stringify(batchFlag.failedIds)}`);

      const finalFlag = {
        ...batchFlag,
        completed: true,
        gaveUp: true,
        permanentlyFailedIds: batchFlag.failedIds,
        failedIds: [],
        completedAt: new Date().toISOString(),
      };
      await saveToSanity('appConfig', `dailyBatch-${today}`, finalFlag);

      // Save daily report documenting the permanent failures
      await saveDailyReport(today, {
        total: batchFlag.fixtureCount || 0,
        analyzed: (batchFlag.fixtureCount || 0) - batchFlag.failedIds.length,
        cached: 0,
        failed: batchFlag.failedIds.length,
        failedIds: batchFlag.failedIds,
        retryCount: currentRetry,
        gaveUp: true,
      });

      return Response.json({
        success: true,
        date: today,
        message: `Gave up on ${batchFlag.failedIds.length} fixtures after ${MAX_RETRIES} retries`,
        permanentlyFailedIds: batchFlag.failedIds,
        retryCount: currentRetry,
      });
    }

    // Load fixtures and filter to only the failed IDs for retry
    const allFixtures = await getCachedFixturesRaw(today);
    if (!allFixtures || allFixtures.length === 0) {
      console.error('[DAILY-BATCH] Cannot retry: no cached fixtures found');
      return Response.json({ error: 'No cached fixtures for retry' }, { status: 500 });
    }

    const failedIdSet = new Set(batchFlag.failedIds);
    const retryFixtures = allFixtures.filter(f => failedIdSet.has(f.fixture?.id));
    console.log(`[DAILY-BATCH] Found ${retryFixtures.length} fixtures to retry out of ${batchFlag.failedIds.length} failed IDs`);

    // Analyze only the failed fixtures
    const { analyzed, cached, failedIds: stillFailedIds } = await analyzeFixturesBatch(retryFixtures, today, force);

    if (stillFailedIds.length > 0) {
      // Still have failures -- save state for next retry
      console.warn(`[DAILY-BATCH] Retry #${currentRetry}: ${stillFailedIds.length} still failing: ${JSON.stringify(stillFailedIds)}`);
      await saveToSanity('appConfig', `dailyBatch-${today}`, {
        ...batchFlag,
        failedIds: stillFailedIds,
        retryCount: currentRetry,
        lastRetryAt: new Date().toISOString(),
      });

      await saveDailyReport(today, {
        total: batchFlag.fixtureCount || 0,
        analyzed: analyzed + ((batchFlag.fixtureCount || 0) - batchFlag.failedIds.length),
        cached,
        failed: stillFailedIds.length,
        failedIds: stillFailedIds,
        retryCount: currentRetry,
        gaveUp: false,
      });

      return Response.json({
        success: true,
        date: today,
        message: `Retry #${currentRetry}: ${analyzed} recovered, ${stillFailedIds.length} still failing`,
        retryCount: currentRetry,
        stillFailedIds,
        analyzed,
      });
    }

    // All previously failed matches now succeeded
    console.log(`[DAILY-BATCH] Retry #${currentRetry}: ALL previously failed fixtures recovered`);
    await saveToSanity('appConfig', `dailyBatch-${today}`, {
      ...batchFlag,
      completed: true,
      failedIds: [],
      retryCount: currentRetry,
      completedAt: new Date().toISOString(),
    });

    await saveDailyReport(today, {
      total: batchFlag.fixtureCount || 0,
      analyzed: (batchFlag.fixtureCount || 0),
      cached: 0,
      failed: 0,
      failedIds: [],
      retryCount: currentRetry,
      gaveUp: false,
    });

    // Notify dashboards that retried analysis is ready
    await triggerEvent('analysis', 'batch-complete', {
      date: today,
      fixtureCount: batchFlag.fixtureCount || 0,
      analyzed,
      retry: currentRetry,
    });

    const quota = await getQuota();
    return Response.json({
      success: true,
      date: today,
      message: `Retry #${currentRetry}: all ${analyzed} recovered fixtures analyzed successfully`,
      retryCount: currentRetry,
      analyzed,
      quota,
    });
  }

  // --- COMPLETED PATH: batch already done, nothing to retry ---
  if (!force && batchFlag?.completed) {
    return Response.json({
      success: true,
      message: 'Batch already completed today',
      date: today,
      fixtureCount: batchFlag.fixtureCount || 0,
    });
  }

  // ===== FRESH BATCH PATH =====

  // Mark batch as started
  await saveToSanity('appConfig', `dailyBatch-${today}`, {
    date: today,
    started: true,
    completed: false,
    failedIds: [],
    retryCount: 0,
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
      const emptySchedule = {
        date: today,
        firstKickoff: null,
        lastExpectedEnd: null,
        kickoffTimes: [],
        fixtureCount: 0,
        createdAt: new Date().toISOString(),
      };
      await saveToSanity('matchSchedule', today, emptySchedule);
      // Also save empty schedule to Redis
      await redisSet(KEYS.schedule(today), emptySchedule, TTL.schedule);
      await saveToSanity('appConfig', `dailyBatch-${today}`, {
        date: today, started: true, completed: true,
        fixtureCount: 0, failedIds: [], retryCount: 0,
        completedAt: new Date().toISOString(),
      });

      await saveDailyReport(today, {
        total: 0, analyzed: 0, cached: 0, failed: 0,
        failedIds: [], retryCount: 0, gaveUp: false,
      });

      return Response.json({ success: true, date: today, fixtureCount: 0, message: 'No fixtures today' });
    }

    // ===== Build and save matchSchedule =====
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

    const scheduleData = {
      date: today,
      firstKickoff,
      lastExpectedEnd,
      kickoffTimes,
      fixtureCount: fixtures.length,
      createdAt: new Date().toISOString(),
    };
    await saveToSanity('matchSchedule', today, scheduleData);

    // ===== Save to Redis for instant access =====
    // Schedule
    await redisSet(KEYS.schedule(today), scheduleData, TTL.schedule);
    // Fixtures list
    await redisSet(KEYS.fixtures(today), fixtures, TTL.fixtures);
    // Also save yesterday's fixtures with longer TTL for day-back navigation
    const yesterday = new Date(new Date(today).getTime() - 86400000).toISOString().split('T')[0];
    const yesterdayDoc = await getCachedFixturesRaw(yesterday);
    if (yesterdayDoc) {
      await redisSet(KEYS.fixtures(yesterday), yesterdayDoc, TTL.yesterday);
    }
    console.log(`[DAILY-BATCH] matchSchedule + Redis saved: ${fixtures.length} matches, first=${new Date(firstKickoff).toISOString()}, last end=${new Date(lastExpectedEnd).toISOString()}`);

    // 2. Analyze ALL matches inline in batches of 3
    const allFixtures = fixtures;

    const { analyzed: totalAnalyzed, cached: totalCached, failedIds } = await analyzeFixturesBatch(allFixtures, today, force);
    const totalFailed = failedIds.length;

    // 3. Determine completion state based on failures
    if (failedIds.length > 0) {
      // Some matches failed -- save incomplete state for retry on next invocation
      console.warn(`[DAILY-BATCH] ${failedIds.length} fixtures failed, saving for retry: ${JSON.stringify(failedIds)}`);
      await saveToSanity('appConfig', `dailyBatch-${today}`, {
        date: today,
        started: true,
        completed: false,
        fixtureCount: allFixtures.length,
        failedIds,
        retryCount: 0,
        lastAttemptAt: new Date().toISOString(),
      });
    } else {
      // All succeeded -- mark complete
      await saveToSanity('appConfig', `dailyBatch-${today}`, {
        date: today,
        started: true,
        completed: true,
        fixtureCount: allFixtures.length,
        failedIds: [],
        retryCount: 0,
        completedAt: new Date().toISOString(),
      });
    }

    // 4. Save daily report
    await saveDailyReport(today, {
      total: allFixtures.length,
      analyzed: totalAnalyzed,
      cached: totalCached,
      failed: totalFailed,
      failedIds,
      retryCount: 0,
      gaveUp: false,
    });

    const quota = await getQuota();
    console.log(`[DAILY-BATCH] Done: ${totalAnalyzed} analyzed, ${totalCached} cached, ${totalFailed} failed`);

    // Notify open dashboards that analysis is ready
    await triggerEvent('analysis', 'batch-complete', {
      date: today,
      fixtureCount: allFixtures.length,
      analyzed: totalAnalyzed,
      failed: totalFailed,
    });

    return Response.json({
      success: true,
      date: today,
      fixtureCount: allFixtures.length,
      analyzed: totalAnalyzed,
      cached: totalCached,
      failed: totalFailed,
      failedIds: failedIds.length > 0 ? failedIds : undefined,
      message: totalFailed > 0
        ? `Completed with failures: ${totalAnalyzed} analyzed, ${totalCached} cached, ${totalFailed} failed (will retry)`
        : `Completed: ${totalAnalyzed} analyzed, ${totalCached} cached`,
      schedule: { firstKickoff: new Date(firstKickoff).toISOString(), lastExpectedEnd: new Date(lastExpectedEnd).toISOString() },
      quota,
    });
  } catch (error) {
    console.error('[DAILY-BATCH] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// ===================== BATCH ANALYSIS HELPER =====================
// Analyzes an array of fixtures in batches of 3, tracking failures.
// Returns { analyzed, cached, failedIds }.
async function analyzeFixturesBatch(fixtures, date, force) {
  const batchSize = 3;
  let analyzed = 0;
  let cached = 0;
  const failedIds = [];

  for (let offset = 0; offset < fixtures.length; offset += batchSize) {
    const batch = fixtures.slice(offset, offset + batchSize);
    console.log(`[DAILY-BATCH] Batch ${offset}/${fixtures.length} (${batch.length} matches)`);

    await Promise.all(
      batch.map(async (fixture) => {
        const fixtureId = fixture.fixture?.id;
        try {
          const r = await analyzeMatch(fixture, { date, force });
          if (r.fromCache) cached++;
          else analyzed++;
        } catch (e) {
          failedIds.push(fixtureId);
          console.error(`[DAILY-BATCH] Failed fixture ${fixtureId}:`, e.message);
        }
      })
    );
  }

  return { analyzed, cached, failedIds };
}

// ===================== DAILY REPORT HELPER =====================
// Saves (or overwrites) a report document to Sanity for observability.
// Document ID: appConfig/dailyReport-{date}
async function saveDailyReport(date, { total, analyzed, cached, failed, failedIds, retryCount, gaveUp }) {
  try {
    await saveToSanity('appConfig', `dailyReport-${date}`, {
      date,
      total,
      analyzed,
      cached,
      failed,
      failedIds: failedIds || [],
      retryCount: retryCount || 0,
      gaveUp: gaveUp || false,
      completedAt: new Date().toISOString(),
    });
    console.log(`[DAILY-BATCH] Report saved: dailyReport-${date}`);
  } catch (e) {
    // Report save is best-effort -- never fail the batch because of it
    console.error(`[DAILY-BATCH] Failed to save daily report:`, e.message);
  }
}
