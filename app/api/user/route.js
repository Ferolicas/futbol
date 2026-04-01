/**
 * /api/user
 * User data: hidden, analyzed, combinadas — all via Supabase.
 */
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../lib/supabase';
import { redisGet, redisSet, KEYS } from '../../../lib/redis';

export const dynamic = 'force-dynamic';
const HIDDEN_TTL = 30 * 24 * 3600;

async function requireUser(supabase) {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// GET: Get user-specific data
export async function GET(request) {
  const supabase = createSupabaseServerClient();
  const user = await requireUser(supabase);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const userId = user.id;

  try {
    if (type === 'hidden') {
      const cached = await redisGet(KEYS.userHidden(userId));
      if (Array.isArray(cached)) return Response.json({ hidden: cached });
      const { data } = await supabaseAdmin.from('user_hidden').select('fixture_id').eq('user_id', userId);
      const ids = (data || []).map(r => r.fixture_id);
      if (ids.length > 0) redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL).catch(() => {});
      return Response.json({ hidden: ids });
    }

    if (type === 'combinadas') {
      const { data, error } = await supabaseAdmin
        .from('combinadas')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) console.error('[user:combinadas]', error.message);
      return Response.json({ combinadas: data || [] });
    }

    return Response.json({ error: 'Invalid type parameter' }, { status: 400 });
  } catch (error) {
    console.error('[user:GET]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Save user-specific data
export async function POST(request) {
  const supabase = createSupabaseServerClient();
  const user = await requireUser(supabase);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { type, data, date: clientDate } = await request.json();
  const userId = user.id;
  const date = clientDate || new Date().toISOString().split('T')[0];

  try {
    if (type === 'hide') {
      await supabaseAdmin.from('user_hidden').upsert(
        { user_id: userId, fixture_id: Number(data.fixtureId), date },
        { onConflict: 'user_id,fixture_id' }
      );
      await redisSet(KEYS.userHidden(userId), null, 1).catch(() => {});
      const { data: rows } = await supabaseAdmin.from('user_hidden').select('fixture_id').eq('user_id', userId);
      const ids = (rows || []).map(r => r.fixture_id);
      await redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL).catch(() => {});
      return Response.json({ hidden: ids });
    }

    if (type === 'unhide') {
      await supabaseAdmin.from('user_hidden').delete().eq('user_id', userId).eq('fixture_id', Number(data.fixtureId));
      await redisSet(KEYS.userHidden(userId), null, 1).catch(() => {});
      const { data: rows } = await supabaseAdmin.from('user_hidden').select('fixture_id').eq('user_id', userId);
      const ids = (rows || []).map(r => r.fixture_id);
      await redisSet(KEYS.userHidden(userId), ids, HIDDEN_TTL).catch(() => {});
      return Response.json({ hidden: ids });
    }

    if (type === 'save-combinada') {
      const normalizedSelections = (data.selections || []).map(s => ({
        fixtureId: String(s.fixtureId || ''),
        matchName: s.matchName || '',
        market: s.name || s.market || '',
        odd: s.odd || 0,
        probability: s.probability || 0,
      }));

      const { data: row, error } = await supabaseAdmin.from('combinadas').insert({
        user_id: userId,
        name: data.name || `Combinada ${new Date().toLocaleDateString('es')}`,
        selections: normalizedSelections,
        combined_odd: data.combinedOdd,
        combined_probability: data.combinedProbability,
        created_at: new Date().toISOString(),
      }).select('id').single();

      if (error) {
        console.error('[user:save-combinada]', error.message);
        return Response.json({ error: 'Error saving combinada' }, { status: 500 });
      }
      return Response.json({ success: true, id: row.id });
    }

    if (type === 'delete-combinada') {
      const combinadaId = data.combinadaId;
      if (!combinadaId) return Response.json({ error: 'combinadaId required' }, { status: 400 });
      const { error } = await supabaseAdmin
        .from('combinadas')
        .delete()
        .eq('id', combinadaId)
        .eq('user_id', userId);
      if (error) console.error('[user:delete-combinada]', error.message);
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Invalid type' }, { status: 400 });
  } catch (error) {
    console.error('[user:POST]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
