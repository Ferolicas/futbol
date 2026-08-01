import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase-auth';
import { supabaseAdmin } from '../../lib/supabase';
import {
  normalizePurchaseIntent,
  normalizePurchasePlan,
  purchaseRoute,
} from '../../lib/purchase-flow';
import PlanesClient from './planes-client';
import { hasActiveEntitlement } from '../../lib/entitlements';

export const metadata = {
  title: 'Selecciona tu Plan - CFanalisis',
};

export default async function PlanesPage({ searchParams }) {
  const autoCheckoutPlan = normalizePurchasePlan(searchParams?.checkout);
  const purchaseIntent = normalizePurchaseIntent(searchParams?.intent);
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect(purchaseRoute('/sign-in', 'plan', autoCheckoutPlan, purchaseIntent));
  }

  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('subscription_status, plan, email, name, role, plan_expires_at, subscription_current_period_end, cancel_at_period_end')
    .eq('id', user.id)
    .single();

  if (hasActiveEntitlement(profile)) {
    redirect('/dashboard');
  }

  const mpPublicKey = process.env.MP_ENV === 'live'
    ? (process.env.MP_PUBLIC_KEY || '')
    : (process.env.NEXT_PUBLIC_MP_PUBLIC_KEY_TEST || '');

  return (
    <PlanesClient
      email={profile?.email || user.email}
      name={profile?.name || user.user_metadata?.display_name || ''}
      mpPublicKey={mpPublicKey}
      autoCheckoutPlan={autoCheckoutPlan}
      purchaseIntent={purchaseIntent}
    />
  );
}
