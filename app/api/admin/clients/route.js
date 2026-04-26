import { stripe } from '../../../../lib/stripe';
import { supabaseAdmin } from '../../../../lib/supabase';
import { getUserProfile } from '../../../../lib/supabase-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const profile = await getUserProfile();
  if (!profile || !['admin', 'owner'].includes(profile.role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data: users, error } = await supabaseAdmin
    .from('user_profiles')
    .select('id, email, name, role, plan, subscription_status, stripe_customer_id, created_at, updated_at')
    .order('created_at', { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const isActive = (u) =>
    u.subscription_status === 'active' || ['admin', 'owner'].includes(u.role);

  const active = users.filter(isActive);
  const pending = users.filter((u) => !isActive(u));

  // Resolve next payment date from Stripe for each active user with customer_id
  if (stripe) {
    await Promise.all(
      active.map(async (u) => {
        if (!u.stripe_customer_id) return;
        try {
          const subs = await stripe.subscriptions.list({
            customer: u.stripe_customer_id,
            status: 'all',
            limit: 5,
          });
          const live = subs.data.find((s) =>
            ['active', 'trialing', 'past_due'].includes(s.status)
          );
          if (live?.current_period_end) {
            u.next_payment_at = new Date(live.current_period_end * 1000).toISOString();
            u.subscription_id = live.id;
            u.stripe_status = live.status;
          } else {
            // Fallback: most recent succeeded charge + 30 days
            const charges = await stripe.charges.list({
              customer: u.stripe_customer_id,
              limit: 10,
            });
            const lastPaid = charges.data
              .filter((c) => c.status === 'succeeded' && !c.refunded)
              .sort((a, b) => b.created - a.created)[0];
            if (lastPaid) {
              u.last_payment_at = new Date(lastPaid.created * 1000).toISOString();
              u.last_payment_amount = lastPaid.amount;
              u.last_payment_currency = lastPaid.currency;
              u.next_payment_at = new Date(
                (lastPaid.created + 30 * 24 * 3600) * 1000
              ).toISOString();
            }
          }
        } catch (e) {
          console.error('[admin/clients] stripe lookup', u.email, e.message);
        }
      })
    );
  }

  return Response.json({
    active: active.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      plan: u.plan,
      stripe_customer_id: u.stripe_customer_id,
      created_at: u.created_at,
      last_payment_at: u.last_payment_at || null,
      last_payment_amount: u.last_payment_amount || null,
      last_payment_currency: u.last_payment_currency || null,
      next_payment_at: u.next_payment_at || null,
      subscription_id: u.subscription_id || null,
      stripe_status: u.stripe_status || null,
    })),
    pending: pending.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      subscription_status: u.subscription_status,
      stripe_customer_id: u.stripe_customer_id,
      created_at: u.created_at,
    })),
    counts: { active: active.length, pending: pending.length },
  });
}
