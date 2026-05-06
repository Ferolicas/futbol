import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

async function authedUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function POST(request) {
  const user = await authedUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { fixtureId, date, action } = await request.json();
  if (!fixtureId) return Response.json({ error: 'Missing fixtureId' }, { status: 400 });

  if (action === 'unhide') {
    await supabaseAdmin.from('baseball_user_hidden')
      .delete()
      .eq('user_id', user.id)
      .eq('fixture_id', fixtureId);
  } else {
    if (!date) return Response.json({ error: 'Missing date' }, { status: 400 });
    await supabaseAdmin.from('baseball_user_hidden')
      .upsert({ user_id: user.id, fixture_id: fixtureId, date, created_at: new Date().toISOString() });
  }
  return Response.json({ success: true });
}
