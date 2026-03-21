import { auth } from '@clerk/nextjs/server';
import { getSanityUserByClerkId } from '../../../lib/clerk-sync';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';
import { redisGet, redisSet, KEYS } from '../../../lib/redis';

const HIDDEN_TTL = 30 * 24 * 3600; // 30 days

export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return Response.json({ hidden: [] });

  const sanityUser = await getSanityUserByClerkId(clerkId);
  const userId = sanityUser?._id;
  if (!userId) return Response.json({ hidden: [] });

  try {
    // Redis first (avoids CDN staleness)
    const cached = await redisGet(KEYS.userHidden(userId));
    if (Array.isArray(cached)) return Response.json({ hidden: cached });

    const doc = await queryFromSanity(
      `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
      { userId }
    );
    const ids = doc?.fixtureIds || [];
    redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL).catch(() => {});
    return Response.json({ hidden: ids });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const sanityUser = await getSanityUserByClerkId(clerkId);
  const userId = sanityUser?._id;
  if (!userId) return Response.json({ error: 'User not found' }, { status: 404 });

  try {
    const { fixtureId, action } = await request.json();
    if (!fixtureId) return Response.json({ error: 'fixtureId required' }, { status: 400 });

    const docId = `hidden-${userId.replace('cfaUser-', '')}`;
    const existing = await queryFromSanity(
      `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
      { userId }
    );
    let ids = existing?.fixtureIds || [];

    if (action === 'unhide') {
      ids = ids.filter(id => id !== Number(fixtureId));
    } else {
      if (!ids.includes(Number(fixtureId))) ids.push(Number(fixtureId));
    }

    await saveToSanity('cfaUserData', docId, {
      userId,
      dataType: 'hidden',
      fixtureIds: ids,
      updatedAt: new Date().toISOString(),
    });

    // Update Redis immediately so next GET bypasses CDN staleness
    await redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL);

    return Response.json({ hidden: ids });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
