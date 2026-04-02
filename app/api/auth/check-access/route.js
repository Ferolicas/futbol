import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ redirect: '/sign-in' });
  }

  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('subscription_status, role')
    .eq('id', user.id)
    .single();

  const isAdmin = ['admin', 'owner'].includes(profile?.role);
  const hasActivePlan = profile?.subscription_status === 'active' || profile?.subscription_status === 'trialing';

  if (isAdmin || hasActivePlan) {
    return Response.json({ redirect: '/dashboard' });
  }

  return Response.json({ redirect: '/planes' });
}
