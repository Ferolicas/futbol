import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase-auth';
import { supabaseAdmin } from '../../lib/supabase';
import ChatWidget from './chat-widget';
import LiveStatsProvider from './live-stats-context';
import SelectedMarketsProvider from './selected-markets-context';
import DashboardHeader from './components/DashboardHeader';

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
    .select('subscription_status, role, plan, name, email')
    .eq('id', user.id)
    .single();

  const isAdmin = ['admin', 'owner'].includes(profile?.role);
  const activeStatuses = ['active', 'trialing'];
  if (!isAdmin && (!profile || !activeStatuses.includes(profile.subscription_status))) {
    redirect('/planes');
  }

  const initialUser = {
    name: profile?.name || user.user_metadata?.display_name || user.email?.split('@')[0],
    email: profile?.email || user.email,
  };

  return (
    <div className="dashboard-layout">
      <DashboardHeader initialUser={initialUser} />
      <SelectedMarketsProvider>
        <LiveStatsProvider>
          {children}
        </LiveStatsProvider>
      </SelectedMarketsProvider>
      <ChatWidget />
    </div>
  );
}
