import { supabaseAdmin } from '../../../../lib/supabase';
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { ALL_LEAGUE_IDS, LEAGUES } from '../../../../lib/leagues';

export const dynamic = 'force-dynamic';

async function getAuthUser() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// GET — returns user's active league IDs (custom or global)
export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile, error } = await supabaseAdmin
      .from('user_profiles')
      .select('custom_league_ids')
      .eq('id', user.id)
      .single();

    if (error) {
      console.error('[user/leagues:GET]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    const leagueIds = profile?.custom_league_ids?.length > 0
      ? profile.custom_league_ids
      : ALL_LEAGUE_IDS;

    return Response.json({ leagueIds, isCustom: !!(profile?.custom_league_ids?.length > 0) });
  } catch (err) {
    console.error('[user/leagues:GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// PUT { leagueIds: number[] | null } — update user's custom leagues (null = reset to global)
export async function PUT(request) {
  try {
    const user = await getAuthUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { leagueIds } = await request.json();

    // Validate all IDs are real league IDs
    const validIds = Array.isArray(leagueIds)
      ? leagueIds.filter(id => ALL_LEAGUE_IDS.includes(Number(id))).map(Number)
      : null;

    const { error } = await supabaseAdmin
      .from('user_profiles')
      .update({ custom_league_ids: validIds && validIds.length > 0 ? validIds : null })
      .eq('id', user.id);

    if (error) {
      console.error('[user/leagues:PUT]', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, leagueIds: validIds });
  } catch (err) {
    console.error('[user/leagues:PUT]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
