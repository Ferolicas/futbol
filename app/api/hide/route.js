import { getServerSession } from 'next-auth';
import { authOptions } from '../../../lib/auth';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return Response.json({ hidden: [] });

  try {
    const doc = await queryFromSanity(
      `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
      { userId }
    );
    return Response.json({ hidden: doc?.fixtureIds || [] });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

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

    return Response.json({ hidden: ids });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
