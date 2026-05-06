import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

async function authedUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function GET() {
  const user = await authedUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await supabaseAdmin
    .from('baseball_user_favorites')
    .select('fixture_id')
    .eq('user_id', user.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ favorites: (data || []).map(f => f.fixture_id) });
}

export async function POST(request) {
  const user = await authedUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { fixtureId, action } = await request.json();
  if (!fixtureId) return Response.json({ error: 'Missing fixtureId' }, { status: 400 });

  if (action === 'remove') {
    await supabaseAdmin.from('baseball_user_favorites')
      .delete()
      .eq('user_id', user.id)
      .eq('fixture_id', fixtureId);
  } else {
    await supabaseAdmin.from('baseball_user_favorites')
      .upsert({ user_id: user.id, fixture_id: fixtureId, created_at: new Date().toISOString() });
  }
  return Response.json({ success: true });
}
