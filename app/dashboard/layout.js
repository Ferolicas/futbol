import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase-auth';
import { supabaseAdmin } from '../../lib/supabase';
import ChatWidget from './chat-widget';

export const metadata = {
  title: 'Dashboard - CFanalisis',
};

export default async function DashboardLayout({ children }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Check subscription status from user_profiles
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('subscription_status, plan')
    .eq('id', user.id)
    .single();

  const activeStatuses = ['active', 'trialing'];
  if (!profile || !activeStatuses.includes(profile.subscription_status)) {
    redirect('/planes');
  }

  return (
    <>
      {children}
      <ChatWidget />
    </>
  );
}
