import { redisGet, redisSet, KEYS } from '../../../lib/redis';

// Force-refresh live data: triggers live + corners crons, then returns fresh data.
// Rate-limited to once every 15s via Redis lock to prevent abuse.
// Called by: dashboard reload button, page load, session start.

export const dynamic = 'force-dynamic';

const LOCK_KEY = 'refresh-live:lock';
const LOCK_TTL = 15; // seconds

export async function POST(request) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Rate limit: 1 forced refresh every 15 seconds across all users
    const lock = await redisGet(LOCK_KEY);
    if (lock) {
      // Already refreshing or just refreshed — return current Redis data immediately
      const liveData = await redisGet(KEYS.liveStats(today));
      return Response.json({
        success: true,
        skipped: true,
        reason: 'Rate limited — returning cached data',
        liveStats: liveData && typeof liveData === 'object' ? liveData : {},
        timestamp: new Date().toISOString(),
      }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // Set lock before triggering crons
    await redisSet(LOCK_KEY, '1', LOCK_TTL);

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000');

    const secret = process.env.CRON_SECRET;

    // Trigger BOTH crons in parallel — live (scores/goals/cards) + corners (statistics)
    const [liveRes, cornersRes] = await Promise.all([
      fetch(`${baseUrl}/api/cron/live?secret=${secret}`, {
        headers: { 'x-internal-trigger': 'true' },
      }).then(r => r.json()).catch(e => ({ error: e.message })),

      fetch(`${baseUrl}/api/cron/live-corners?secret=${secret}`, {
        headers: { 'x-internal-trigger': 'true' },
      }).then(r => r.json()).catch(e => ({ error: e.message })),
    ]);

    // Read fresh data from Redis (both crons just wrote to it)
    const liveData = await redisGet(KEYS.liveStats(today));

    return Response.json({
      success: true,
      liveStats: liveData && typeof liveData === 'object' ? liveData : {},
      liveCron: { success: liveRes?.success, liveCount: liveRes?.liveCount, apiCalls: liveRes?.apiCalls },
      cornersCron: { success: cornersRes?.success, updatedMatches: cornersRes?.updatedMatches, apiCalls: cornersRes?.apiCalls },
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[REFRESH-LIVE] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
