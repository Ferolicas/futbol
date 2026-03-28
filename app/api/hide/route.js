import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../../lib/auth';
import { queryFromSanityFresh, saveToSanity } from '../../../lib/sanity';
import { redisGet, redisSet, KEYS } from '../../../lib/redis';

const HIDDEN_TTL = 30 * 24 * 3600; // 30 days

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return Response.json({ hidden: [] });

  const userId = session.user.id;

  try {
    const cached = await redisGet(KEYS.userHidden(userId));
    if (Array.isArray(cached)) return Response.json({ hidden: cached });

    const doc = await queryFromSanityFresh(
      `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
      { userId }
    );
    const ids = doc?.fixtureIds || [];
    if (ids.length > 0) redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL).catch(() => {});
    return Response.json({ hidden: ids });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;

  try {
    const { fixtureId, action } = await request.json();
    if (!fixtureId) return Response.json({ error: 'fixtureId required' }, { status: 400 });

    const docId = `hidden-${userId.replace('cfaUser-', '')}`;

    const cachedIds = await redisGet(KEYS.userHidden(userId));
    let ids;
    if (Array.isArray(cachedIds)) {
      ids = cachedIds;
    } else {
      const existing = await queryFromSanityFresh(
        `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
        { userId }
      );
      ids = existing?.fixtureIds || [];
    }

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

    await redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL);

    return Response.json({ hidden: ids });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
