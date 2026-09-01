import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase-auth';
import { supabaseAdmin } from '../../lib/supabase';
import ChatWidget from './chat-widget';
import LiveStatsProvider from './live-stats-context';
import SelectedMarketsProvider from './selected-markets-context';
import DashboardHeader from './components/DashboardHeader';
import ScrollToTopButton from './components/ScrollToTopButton';
import { hasActiveEntitlement } from '../../lib/entitlements';

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
    .select('subscription_status, role, plan_expires_at, subscription_current_period_end, cancel_at_period_end')
    .eq('id', user.id)
    .single();

  const isAdmin = ['admin', 'owner'].includes(profile?.role);
  if (!isAdmin && !hasActiveEntitlement(profile)) {
    redirect('/planes');
  }

  return (
    <div className="dashboard-layout">
      <DashboardHeader />
      <SelectedMarketsProvider>
        <LiveStatsProvider>
          {children}
        </LiveStatsProvider>
      </SelectedMarketsProvider>
      <ScrollToTopButton />
      <ChatWidget />
    </div>
  );
}
