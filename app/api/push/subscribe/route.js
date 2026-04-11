import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';
import { vapidPublicKey } from '../../../../lib/webpush';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ vapidPublicKey });
}

// Helper: normalize subscription storage to always be an array
function toArray(stored) {
  if (!stored) return [];
  return Array.isArray(stored) ? stored : [stored];
}

export async function POST(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const newSub = await request.json();
  const endpoint = newSub?.endpoint;
  if (!endpoint) return Response.json({ error: 'Invalid subscription' }, { status: 400 });

  // Load existing row (if any) and merge the new device subscription
  const { data: existing } = await supabaseAdmin
    .from('push_subscriptions')
    .select('subscription')
    .eq('user_id', user.id)
    .maybeSingle();

  // Deduplicate by endpoint — replace same-endpoint entry, keep others
  const prevArray = toArray(existing?.subscription);
  const updatedArray = [...prevArray.filter(s => s?.endpoint !== endpoint), newSub];

  const { error } = await supabaseAdmin.from('push_subscriptions').upsert({
    user_id: user.id,
    subscription: updatedArray,
  }, { onConflict: 'user_id' });
  if (error) console.error('[push:subscribe]', error.message);

  return Response.json({ success: true, deviceCount: updatedArray.length });
}

export async function DELETE(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const endpoint = body.endpoint; // specific device endpoint to remove

  if (endpoint) {
    // Remove only this device's subscription, keep others
    const { data: existing } = await supabaseAdmin
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', user.id)
      .maybeSingle();

    const prevArray = toArray(existing?.subscription);
    const remaining = prevArray.filter(s => s?.endpoint !== endpoint);

    if (remaining.length === 0) {
      // No devices left — remove the row entirely
      const { error } = await supabaseAdmin
        .from('push_subscriptions')
        .delete()
        .eq('user_id', user.id);
      if (error) console.error('[push:unsubscribe]', error.message);
    } else {
      // Update with remaining devices
      const { error } = await supabaseAdmin
        .from('push_subscriptions')
        .update({ subscription: remaining })
        .eq('user_id', user.id);
      if (error) console.error('[push:unsubscribe:update]', error.message);
    }
  } else {
    // Legacy / unsubscribe all — remove the entire row
    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .delete()
      .eq('user_id', user.id);
    if (error) console.error('[push:unsubscribe:all]', error.message);
  }

  return Response.json({ success: true });
}
