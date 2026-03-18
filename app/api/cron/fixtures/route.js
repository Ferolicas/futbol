import { getFixtures, getQuota } from '../../../../lib/api-football';
import { saveToSanity } from '../../../../lib/sanity';

// Cron: runs at 10:00 AM Spain time (08:00 UTC)
// cron-job.org: GET /api/cron/fixtures?secret=CRON_SECRET

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function verifyCronAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  return secret === process.env.CRON_SECRET || process.env.NODE_ENV !== 'production';
}

export async function GET(request) {
  if (!verifyCronAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[CRON] Loading fixtures for ${today}...`);

    const result = await getFixtures(today);
    const fixtures = result.fixtures || [];

    const quota = await getQuota();
    let tomorrowCount = 0;

    if (quota.remaining > 100) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowDate = tomorrow.toISOString().split('T')[0];

      try {
        const tResult = await getFixtures(tomorrowDate);
        tomorrowCount = tResult.fixtures?.length || 0;
      } catch (e) {
        console.error('[CRON] Tomorrow fetch failed:', e.message);
      }
    }

    const finalQuota = await getQuota();

    return Response.json({
      success: true,
      date: today,
      fixtureCount: fixtures.length,
      tomorrowCount,
      quota: finalQuota,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[CRON] Fixtures error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
