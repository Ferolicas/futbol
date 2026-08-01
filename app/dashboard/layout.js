import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase-auth';
import { supabaseAdmin } from '../../lib/supabase';
import ChatWidget from './chat-widget';
import LiveStatsProvider from './live-stats-context';
import SelectedMarketsProvider from './selected-markets-context';
import DashboardHeader from './components/DashboardHeader';
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
    .select('subscription_status, role, plan, name, email, payment_provider, stripe_subscription_id, mp_preapproval_id, plan_expires_at, subscription_current_period_end, cancel_at_period_end')
    .eq('id', user.id)
    .single();

  const isAdmin = ['admin', 'owner'].includes(profile?.role);
  if (!isAdmin && !hasActiveEntitlement(profile)) {
    redirect('/planes');
  }

  const initialUser = {
    name: profile?.name || user.user_metadata?.display_name || user.email?.split('@')[0],
    email: profile?.email || user.email,
    paymentProvider: profile?.payment_provider || null,
    hasRecurringSubscription: !!((
      profile?.payment_provider === 'stripe'
      && profile?.stripe_subscription_id
    ) || (
      profile?.payment_provider === 'mercadopago'
      && profile?.mp_preapproval_id
      && !/^\d+$/.test(String(profile.mp_preapproval_id))
    )),
    cancelAtPeriodEnd: !!profile?.cancel_at_period_end,
    accessUntil: profile?.subscription_current_period_end || profile?.plan_expires_at || null,
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
