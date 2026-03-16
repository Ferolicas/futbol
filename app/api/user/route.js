import { getServerSession } from 'next-auth';
import { authOptions } from '../../../lib/auth';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';

export const dynamic = 'force-dynamic';

// GET: Get user-specific data (hidden, analyzed, combinadas)
export async function GET(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type'); // 'hidden', 'analyzed', 'combinadas'
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const userId = session.user.id;

  try {
    if (type === 'hidden') {
      const doc = await queryFromSanity(
        `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
        { userId }
      );
      return Response.json({ hidden: doc?.fixtureIds || [] });
    }

    if (type === 'analyzed') {
      const doc = await queryFromSanity(
        `*[_type == "cfaUserData" && userId == $userId && dataType == "analyzed" && date == $date][0]`,
        { userId, date }
      );
      return Response.json({ analyzed: doc?.fixtureIds || [] });
    }

    if (type === 'combinadas') {
      const docs = await queryFromSanity(
        `*[_type == "cfaCombinada" && userId == $userId] | order(_createdAt desc)`,
        { userId }
      );
      return Response.json({ combinadas: docs || [] });
    }

    return Response.json({ error: 'Invalid type parameter' }, { status: 400 });
  } catch (error) {
    console.error('User data error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Save user-specific data
export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { type, data } = await request.json();
  const userId = session.user.id;
  const date = new Date().toISOString().split('T')[0];

  try {
    if (type === 'hide') {
      // Add fixture to user's hidden list
      const docId = `hidden-${userId.replace('cfaUser-', '')}`;
      const existing = await queryFromSanity(
        `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
        { userId }
      );
      const ids = existing?.fixtureIds || [];
      if (!ids.includes(data.fixtureId)) ids.push(data.fixtureId);

      await saveToSanity('cfaUserData', docId, {
        userId,
        dataType: 'hidden',
        fixtureIds: ids,
        updatedAt: new Date().toISOString(),
      });

      return Response.json({ hidden: ids });
    }

    if (type === 'unhide') {
      const docId = `hidden-${userId.replace('cfaUser-', '')}`;
      const existing = await queryFromSanity(
        `*[_type == "cfaUserData" && userId == $userId && dataType == "hidden"][0]`,
        { userId }
      );
      const ids = (existing?.fixtureIds || []).filter(id => id !== data.fixtureId);

      await saveToSanity('cfaUserData', docId, {
        userId,
        dataType: 'hidden',
        fixtureIds: ids,
        updatedAt: new Date().toISOString(),
      });

      return Response.json({ hidden: ids });
    }

    if (type === 'analyze') {
      // Mark fixture as analyzed for this user
      const docId = `analyzed-${userId.replace('cfaUser-', '')}-${date}`;
      const existing = await queryFromSanity(
        `*[_type == "cfaUserData" && userId == $userId && dataType == "analyzed" && date == $date][0]`,
        { userId, date }
      );
      const ids = existing?.fixtureIds || [];
      if (data.fixtureIds) {
        data.fixtureIds.forEach(id => { if (!ids.includes(id)) ids.push(id); });
      }

      await saveToSanity('cfaUserData', docId, {
        userId,
        dataType: 'analyzed',
        date,
        fixtureIds: ids,
        updatedAt: new Date().toISOString(),
      });

      return Response.json({ analyzed: ids });
    }

    if (type === 'remove-analyzed') {
      // Remove a fixture from analyzed list
      const docId = `analyzed-${userId.replace('cfaUser-', '')}-${date}`;
      const existing = await queryFromSanity(
        `*[_type == "cfaUserData" && userId == $userId && dataType == "analyzed" && date == $date][0]`,
        { userId, date }
      );
      const ids = (existing?.fixtureIds || []).filter(id => id !== data.fixtureId);

      await saveToSanity('cfaUserData', docId, {
        userId,
        dataType: 'analyzed',
        date,
        fixtureIds: ids,
        updatedAt: new Date().toISOString(),
      });

      return Response.json({ analyzed: ids });
    }

    if (type === 'save-combinada') {
      // Save a custom combinada for this user
      const docId = `comb-${userId.replace('cfaUser-', '')}-${Date.now()}`;

      await saveToSanity('cfaCombinada', docId, {
        userId,
        name: data.name || `Combinada ${new Date().toLocaleDateString('es')}`,
        selections: data.selections,
        combinedOdd: data.combinedOdd,
        combinedProbability: data.combinedProbability,
        createdAt: new Date().toISOString(),
      });

      return Response.json({ success: true, id: docId });
    }

    if (type === 'delete-combinada') {
      // Delete a saved combinada
      const { deleteFromSanity } = await import('../../../lib/sanity');
      const docId = data.combinadaId?.replace('cfaCombinada-', '');
      if (docId) await deleteFromSanity('cfaCombinada', docId);
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Invalid type' }, { status: 400 });
  } catch (error) {
    console.error('User data save error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
