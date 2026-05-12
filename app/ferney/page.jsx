import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase-auth';
import { supabaseAdmin } from '../../lib/supabase';
import FerneyDashboard from './Dashboard';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ferney · Panel del worker', robots: 'noindex' };

export default async function FerneyPage() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/sign-in');

  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('role, email')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !['admin', 'owner'].includes(profile.role)) {
    redirect('/dashboard');
  }

  return <FerneyDashboard user={{ email: profile.email || user.email }} />;
}
