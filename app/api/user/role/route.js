import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('role, plan')
      .eq('id', user.id)
      .single();

    return Response.json({ role: profile?.role || 'user', plan: profile?.plan || 'free' });
  } catch (err) {
    console.error('[user/role:GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
