import { supabaseAdmin } from '../../../lib/supabase';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

async function getAuthUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// GET — list all favorites for the current user
export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabaseAdmin
      .from('user_favorites')
      .select('fixture_id, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[favorites:GET]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ favorites: data.map(r => r.fixture_id) });
  } catch (err) {
    console.error('[favorites:GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// POST { fixtureId } — add to favorites
export async function POST(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { fixtureId } = await request.json();
    if (!fixtureId) return Response.json({ error: 'fixtureId required' }, { status: 400 });

    const { error } = await supabaseAdmin
      .from('user_favorites')
      .upsert({ user_id: user.id, fixture_id: Number(fixtureId) }, { onConflict: 'user_id,fixture_id' });

    if (error) {
      console.error('[favorites:POST]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, fixtureId });
  } catch (err) {
    console.error('[favorites:POST]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// DELETE { fixtureId } — remove from favorites
export async function DELETE(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { fixtureId } = await request.json();
    if (!fixtureId) return Response.json({ error: 'fixtureId required' }, { status: 400 });

    const { error } = await supabaseAdmin
      .from('user_favorites')
      .delete()
      .eq('user_id', user.id)
      .eq('fixture_id', Number(fixtureId));

    if (error) {
      console.error('[favorites:DELETE]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, fixtureId });
  } catch (err) {
    console.error('[favorites:DELETE]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
