import { getServerSession } from 'next-auth/next';
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
  const type = searchParams.get('type');
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

  const { type, data, date: clientDate } = await request.json();
  const userId = session.user.id;
  const date = clientDate || new Date().toISOString().split('T')[0];

  try {
    if (type === 'hide') {
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
      // Store the fixture ID in the user's "removed" list so it stays hidden on refresh
      const docId = `removed-analyzed-${userId.replace('cfaUser-', '')}-${date}`;
      const existing = await queryFromSanity(
        `*[_type == "cfaUserData" && userId == $userId && dataType == "removedAnalyzed" && date == $date][0]`,
        { userId, date }
      );
      const ids = existing?.fixtureIds || [];
      if (!ids.includes(data.fixtureId)) ids.push(data.fixtureId);

      await saveToSanity('cfaUserData', docId, {
        userId,
        dataType: 'removedAnalyzed',
        date,
        fixtureIds: ids,
        updatedAt: new Date().toISOString(),
      });

      return Response.json({ removed: ids });
    }

    if (type === 'save-combinada') {
      const docId = `comb-${userId.replace('cfaUser-', '')}-${Date.now()}`;

      // Normalize selection fields: client sends 'name' but schema expects 'market'
      const normalizedSelections = (data.selections || []).map(s => ({
        fixtureId: String(s.fixtureId || ''),
        matchName: s.matchName || '',
        market: s.name || s.market || '',
        odd: s.odd || 0,
        probability: s.probability || 0,
      }));

      await saveToSanity('cfaCombinada', docId, {
        userId,
        name: data.name || `Combinada ${new Date().toLocaleDateString('es')}`,
        selections: normalizedSelections,
        combinedOdd: data.combinedOdd,
        combinedProbability: data.combinedProbability,
        createdAt: new Date().toISOString(),
      });

      return Response.json({ success: true, id: docId });
    }

    if (type === 'delete-combinada') {
      const { deleteFromSanity, queryFromSanity: qSanity } = await import('../../../lib/sanity');
      const docId = data.combinadaId?.replace('cfaCombinada-', '');
      if (docId) {
        // Verify ownership before deleting
        const owned = await qSanity(
          `*[_type == "cfaCombinada" && _id == $id && userId == $userId][0]{ _id }`,
          { id: `cfaCombinada-${docId}`, userId }
        );
        if (!owned) return Response.json({ error: 'Not found' }, { status: 404 });
        await deleteFromSanity('cfaCombinada', docId);
      }
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Invalid type' }, { status: 400 });
  } catch (error) {
    console.error('User data save error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
