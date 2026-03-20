import { auth, currentUser } from '@clerk/nextjs/server';
import { analyzeMatch } from '../../../../lib/api-football';
import { getCachedFixturesRaw, getCachedAnalysis } from '../../../../lib/sanity-cache';
import { redisGet, redisDel, KEYS } from '../../../../lib/redis';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const OWNER_EMAIL = 'ferneyolicas@gmail.com';

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase();
  if (email !== OWNER_EMAIL) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const today = new Date().toISOString().split('T')[0];

  // Try Sanity first, fall back to Redis (page loads use Redis directly, Sanity may be empty)
  let fixtures = await getCachedFixturesRaw(today);
  if (!fixtures || fixtures.length === 0) {
    const redisFixtures = await redisGet(KEYS.fixtures(today));
    if (Array.isArray(redisFixtures) && redisFixtures.length > 0) {
      fixtures = redisFixtures;
    }
  }

  if (!fixtures || fixtures.length === 0) {
    return Response.json({ success: true, analyzed: 0, message: 'No fixtures for today' });
  }

  // Stream progress via SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let analyzed = 0;
      let skipped = 0;
      let failed = 0;
      const total = fixtures.length;

      send({ type: 'start', total });

      for (let i = 0; i < fixtures.length; i += 5) {
        const batch = fixtures.slice(i, i + 5);
        await Promise.all(
          batch.map(async (fixture) => {
            const fid = fixture.fixture?.id;
            const name = `${fixture.teams?.home?.name || '?'} vs ${fixture.teams?.away?.name || '?'}`;
            try {
              const existing = await getCachedAnalysis(fid, today);
              if (existing) {
                skipped++;
              } else {
                await analyzeMatch(fixture, { date: today });
                analyzed++;
              }
            } catch (e) {
              failed++;
              console.error(`[REANALYZE] Failed ${fid}:`, e.message);
            }
            send({
              type: 'progress',
              current: analyzed + skipped + failed,
              total,
              analyzed,
              skipped,
              failed,
              match: name,
            });
          })
        );
      }

      // Bust analysis Redis cache so next loadFixtures reads fresh data from Sanity
      await redisDel(`analysis:${today}`);

      send({ type: 'done', analyzed, skipped, failed, total });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
