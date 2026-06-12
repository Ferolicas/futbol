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
  if (!user) redirect('/sign-in');

  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('subscription_status, plan, email, name')
    .eq('id', user.id)
    .single();

  const activeStatuses = ['active', 'trialing'];
  if (profile && activeStatuses.includes(profile.subscription_status)) {
    redirect('/dashboard');
  }

  const mpPublicKey = process.env.MP_ENV === 'live'
    ? (process.env.MP_PUBLIC_KEY || '')
    : (process.env.NEXT_PUBLIC_MP_PUBLIC_KEY_TEST || '');

  return (
    <PlanesClient
      userId={user.id}
      email={profile?.email || user.email}
      mpPublicKey={mpPublicKey}
    />
  );
}
