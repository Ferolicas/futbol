import { createEmbeddedPayment, isValidPlan } from '../../../lib/stripe';
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../lib/supabase';

export async function POST(request) {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { plan, email, currency } = await request.json();
    if (!plan || !email) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!isValidPlan(plan)) {
      return Response.json({ error: 'Invalid plan' }, { status: 400 });
    }

    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('id, name, email, role, stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (!profile) return Response.json({ error: 'User not found' }, { status: 404 });
    if (profile.email?.toLowerCase() !== email.toLowerCase().trim()) {
      return Response.json({ error: 'Email mismatch' }, { status: 403 });
    }

    const result = await createEmbeddedPayment({
      plan,
      userId: profile.id,
      email: profile.email,
      name: profile.name,
      currency: currency || 'USD',
    });

    // Save only the Stripe customer ID — plan stays null until webhook confirms payment
    const { error: _err1 } = await supabaseAdmin.from('user_profiles').update({
      subscription_status: 'pending',
      stripe_customer_id: result.customerId,
      updated_at: new Date().toISOString(),
    }).eq('id', profile.id);
    if (_err1) console.error('[checkout:update]', _err1.message);

    return Response.json({
      clientSecret: result.clientSecret,
      plan: result.plan,
      amount: result.amount,
      currency: result.currency || 'usd',
    });
  } catch (error) {
    console.error('[checkout]', error.message);
    return Response.json({ error: error.message || 'Checkout failed' }, { status: 500 });
  }
}
