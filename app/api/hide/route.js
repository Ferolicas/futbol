/**
 * Legacy /api/hide endpoint — now delegates to /api/hidden
 * Kept for backward compatibility.
 */
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../lib/supabase';
import { redisGet, redisSet, KEYS } from '../../../lib/redis';

const HIDDEN_TTL = 30 * 24 * 3600;

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ hidden: [] });

  const cached = await redisGet(KEYS.userHidden(user.id));
  if (Array.isArray(cached)) return Response.json({ hidden: cached });

  const { data } = await supabaseAdmin
    .from('user_hidden')
    .select('fixture_id')
    .eq('user_id', user.id);
  const ids = (data || []).map(r => r.fixture_id);
  if (ids.length > 0) redisSet(KEYS.userHidden(user.id), ids, HIDDEN_TTL).catch(() => {});
  return Response.json({ hidden: ids });
}

export async function POST(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { fixtureId, action, date } = await request.json();
  if (!fixtureId) return Response.json({ error: 'fixtureId required' }, { status: 400 });

  const today = date || new Date().toISOString().split('T')[0];

  if (action === 'unhide') {
    await supabaseAdmin
      .from('user_hidden')
      .delete()
      .eq('user_id', user.id)
      .eq('fixture_id', Number(fixtureId))
      .catch(e => console.error('[hide:unhide]', e.message));
  } else {
    await supabaseAdmin
      .from('user_hidden')
      .upsert({ user_id: user.id, fixture_id: Number(fixtureId), date: today }, { onConflict: 'user_id,fixture_id' })
      .catch(e => console.error('[hide:hide]', e.message));
  }

  // Invalidate Redis cache
  await redisSet(KEYS.userHidden(user.id), null, 1).catch(() => {});

  const { data } = await supabaseAdmin.from('user_hidden').select('fixture_id').eq('user_id', user.id);
  const ids = (data || []).map(r => r.fixture_id);
  await redisSet(KEYS.userHidden(user.id), ids, HIDDEN_TTL).catch(() => {});
  return Response.json({ hidden: ids });
}
