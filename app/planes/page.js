import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase-auth';
import { supabaseAdmin } from '../../lib/supabase';
import PlanesClient from './planes-client';

export const metadata = {
  title: 'Selecciona tu Plan - CFanalisis',
};

export default async function PlanesPage() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('subscription_status, plan, email, name')
    .eq('id', user.id)
    .single();

  const activeStatuses = ['active', 'trialing'];
  if (profile && activeStatuses.includes(profile.subscription_status)) {
    redirect('/dashboard');
  }

  return (
    <PlanesClient
      userId={user.id}
      email={profile?.email || user.email}
    />
  );
}
