import { createSupabaseServerClient } from '../../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return Response.json({ user: null }, { status: 401 });
    }

    const { supabaseAdmin } = await import('../../../../../lib/supabase');
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('id, email, name, role, plan, timezone, custom_league_ids')
      .eq('id', user.id)
      .single();

    return Response.json({ user: { ...user, ...profile } });
  } catch (err) {
    console.error('[auth/session]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
