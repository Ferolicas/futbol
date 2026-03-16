import { getFixtures, getQuota } from '../../../../lib/api-football';
import { getFromSanity, saveToSanity } from '../../../../lib/sanity';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Master daily batch: fetches fixtures + triggers analysis of ALL matches
// Auto-triggered by first user of the day OR called externally
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret') || request.headers.get('authorization')?.replace('Bearer ', '');

  const isInternal = request.headers.get('x-internal-trigger') === 'true';
  if (!isInternal && secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = new Date().toISOString().split('T')[0];

  // Check if batch already ran today
  const batchFlag = await getFromSanity('appConfig', `dailyBatch-${today}`);
  if (batchFlag?.started) {
    return Response.json({
      success: true,
      message: batchFlag.completed ? 'Batch already completed today' : 'Batch already running',
      date: today,
      fixtureCount: batchFlag.fixtureCount || 0,
    });
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
      await saveToSanity('appConfig', `dailyBatch-${today}`, {
        date: today,
        started: true,
        completed: true,
        fixtureCount: 0,
        completedAt: new Date().toISOString(),
      });
      return Response.json({ success: true, date: today, fixtureCount: 0, message: 'No fixtures today' });
    }

    // 2. Fire first analysis batch (non-blocking chain)
    const batchSize = 3;
    const baseUrl = process.env.NEXTAUTH_URL || (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000');

    fetch(`${baseUrl}/api/cron/analyze-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-trigger': 'true',
      },
      body: JSON.stringify({
        offset: 0,
        batchSize,
        date: today,
        totalFixtures: fixtures.length,
      }),
    }).catch(() => {});

    // Update batch flag with fixture count
    await saveToSanity('appConfig', `dailyBatch-${today}`, {
      date: today,
      started: true,
      completed: false,
      fixtureCount: fixtures.length,
      totalBatches: Math.ceil(fixtures.length / batchSize),
      startedAt: new Date().toISOString(),
    });

    const quota = await getQuota();

    return Response.json({
      success: true,
      date: today,
      fixtureCount: fixtures.length,
      message: `Analyzing ${fixtures.length} matches in background...`,
      quota,
    });
  } catch (error) {
    console.error('[DAILY-BATCH] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
