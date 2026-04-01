import { supabaseAdmin } from '../../../lib/supabase';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

async function getAuthUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// GET ?date=YYYY-MM-DD — list hidden fixtures for user on a date
export async function GET(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date');

    let query = supabaseAdmin
      .from('user_hidden')
      .select('fixture_id, date')
      .eq('user_id', user.id);

    if (date) query = query.eq('date', date);

    const { data, error } = await query;

    if (error) {
      console.error('[hidden:GET]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ hidden: data.map(r => r.fixture_id) });
  } catch (err) {
    console.error('[hidden:GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// POST { fixtureId, date } — hide a fixture for the current user
export async function POST(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { fixtureId, date } = await request.json();
    if (!fixtureId || !date) return Response.json({ error: 'fixtureId and date required' }, { status: 400 });

    const { error } = await supabaseAdmin
      .from('user_hidden')
      .upsert(
        { user_id: user.id, fixture_id: Number(fixtureId), date },
        { onConflict: 'user_id,fixture_id' }
      );

    if (error) {
      console.error('[hidden:POST]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, fixtureId });
  } catch (err) {
    console.error('[hidden:POST]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// DELETE { fixtureId } — unhide a fixture
export async function DELETE(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { fixtureId } = await request.json();
    if (!fixtureId) return Response.json({ error: 'fixtureId required' }, { status: 400 });

    const { error } = await supabaseAdmin
      .from('user_hidden')
      .delete()
      .eq('user_id', user.id)
      .eq('fixture_id', Number(fixtureId));

    if (error) {
      console.error('[hidden:DELETE]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, fixtureId });
  } catch (err) {
    console.error('[hidden:DELETE]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
