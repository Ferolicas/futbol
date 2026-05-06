import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase-auth';
import { supabaseAdmin } from '../../lib/supabase';
import ChatWidget from './chat-widget';
import LiveStatsProvider from './live-stats-context';
import SelectedMarketsProvider from './selected-markets-context';
import SportToggle from './components/SportToggle';

export const metadata = {
  title: 'Dashboard - CFanalisis',
};

export default async function DashboardLayout({ children }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/sign-in');

  // Check subscription status from user_profiles
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('subscription_status, role, plan')
    .eq('id', user.id)
    .single();

  const isAdmin = ['admin', 'owner'].includes(profile?.role);
  const activeStatuses = ['active', 'trialing'];
  if (!isAdmin && (!profile || !activeStatuses.includes(profile.subscription_status))) {
    redirect('/planes');
  }

  return (
    <>
      <SelectedMarketsProvider>
        <LiveStatsProvider>
          <div style={{ paddingTop: 16 }}>
            <SportToggle />
          </div>
          {children}
        </LiveStatsProvider>
      </SelectedMarketsProvider>
      <ChatWidget />
    </>
  );
}
