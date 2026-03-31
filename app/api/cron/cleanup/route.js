import { createClient } from '@sanity/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function getClient() {
  return createClient({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID,
    dataset: process.env.SANITY_DATASET || 'production',
    apiVersion: '2024-07-11',
    token: process.env.SANITY_API_TOKEN,
    useCdn: false,
  });
}

function cutoffDateStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0]; // "YYYY-MM-DD"
}

function cutoffDatetimeStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

async function deleteInBatches(client, ids) {
  if (!ids.length) return 0;
  const BATCH = 200;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const tx = client.transaction();
    slice.forEach(id => tx.delete(id));
    await tx.commit({ visibility: 'async' });
    deleted += slice.length;
  }
  return deleted;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');

  if (secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // purge=true → one-time initial purge keeping only last 3 days
  // default     → routine cleanup keeping last 7 days
  const isPurge = searchParams.get('purge') === 'true';
  const retentionDays = isPurge ? 3 : 7;

  const client = getClient();
  const cutoffDate = cutoffDateStr(retentionDays);
  const cutoffDt   = cutoffDatetimeStr(retentionDays);

  console.log(`[CLEANUP] Starting ${isPurge ? 'PURGE' : 'routine'} cleanup — cutoff: ${cutoffDate}`);

  const results = {};

  // ── 1. apiCache (injuries, lineups, matchstats, matchplayers, matchevents, standings, h2h…)
  {
    const ids = await client.fetch(
      `*[_type == "apiCache" && fetchedAt < $cutoff]._id`,
      { cutoff: cutoffDt }
    );
    results.apiCache = await deleteInBatches(client, ids);
    console.log(`[CLEANUP] apiCache: ${results.apiCache} deleted`);
  }

  // ── 2. footballMatchAnalysis
  {
    const ids = await client.fetch(
      `*[_type == "footballMatchAnalysis" && (
        (defined(fetchedAt) && fetchedAt < $cutoffDt)
        || (defined(date) && date < $cutoffDate && !defined(fetchedAt))
      )]._id`,
      { cutoffDt: cutoffDt, cutoffDate }
    );
    results.footballMatchAnalysis = await deleteInBatches(client, ids);
    console.log(`[CLEANUP] footballMatchAnalysis: ${results.footballMatchAnalysis} deleted`);
  }

  // ── 3. liveMatchStats
  {
    const ids = await client.fetch(
      `*[_type == "liveMatchStats" && defined(date) && date < $cutoffDate]._id`,
      { cutoffDate }
    );
    results.liveMatchStats = await deleteInBatches(client, ids);
    console.log(`[CLEANUP] liveMatchStats: ${results.liveMatchStats} deleted`);
  }

  // ── 4. footballFixturesCache
  {
    const ids = await client.fetch(
      `*[_type == "footballFixturesCache" && defined(date) && date < $cutoffDate]._id`,
      { cutoffDate }
    );
    results.footballFixturesCache = await deleteInBatches(client, ids);
    console.log(`[CLEANUP] footballFixturesCache: ${results.footballFixturesCache} deleted`);
  }

  // ── 5. matchSchedule (unregistered type, saved by saveToSanity)
  {
    const ids = await client.fetch(
      `*[_type == "matchSchedule" && defined(date) && date < $cutoffDate]._id`,
      { cutoffDate }
    );
    results.matchSchedule = await deleteInBatches(client, ids);
    console.log(`[CLEANUP] matchSchedule: ${results.matchSchedule} deleted`);
  }

  // ── 6. appConfig dated docs (dailyBatch-*, analyzed-*, apiCalls-*)
  //    Permanent docs like "hiddenMatches" have no `date` field — safe to filter by defined(date)
  {
    const ids = await client.fetch(
      `*[_type == "appConfig" && defined(date) && date < $cutoffDate]._id`,
      { cutoffDate }
    );
    results.appConfig = await deleteInBatches(client, ids);
    console.log(`[CLEANUP] appConfig: ${results.appConfig} deleted`);
  }

  // ── 7. cfaUserData — only dated types (analyzed, removedAnalyzed)
  //    "hidden" and "pushSubscription" are permanent — excluded by dataType filter
  {
    const ids = await client.fetch(
      `*[_type == "cfaUserData" && dataType in ["analyzed", "removedAnalyzed"] && defined(date) && date < $cutoffDate]._id`,
      { cutoffDate }
    );
    results.cfaUserData = await deleteInBatches(client, ids);
    console.log(`[CLEANUP] cfaUserData: ${results.cfaUserData} deleted`);
  }

  // ── 8. oddsCache — by fetchedAt
  {
    const ids = await client.fetch(
      `*[_type == "oddsCache" && defined(fetchedAt) && fetchedAt < $cutoff]._id`,
      { cutoff: cutoffDt }
    );
    results.oddsCache = await deleteInBatches(client, ids);
    console.log(`[CLEANUP] oddsCache: ${results.oddsCache} deleted`);
  }

  const total = Object.values(results).reduce((a, b) => a + b, 0);

  console.log(`[CLEANUP] Done — ${total} documents deleted total`);

  return Response.json({
    success: true,
    retentionDays,
    cutoffDate,
    deleted: results,
    total,
    timestamp: new Date().toISOString(),
  });
}
