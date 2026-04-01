import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';
import { vapidPublicKey } from '../../../../lib/webpush';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ vapidPublicKey });
}

export async function POST(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const subscription = await request.json();

  await supabaseAdmin.from('push_subscriptions').upsert({
    user_id: user.id,
    subscription,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' }).catch(e => console.error('[push:subscribe]', e.message));

  return Response.json({ success: true });
}

export async function DELETE() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  await supabaseAdmin
    .from('push_subscriptions')
    .delete()
    .eq('user_id', user.id)
    .catch(e => console.error('[push:unsubscribe]', e.message));

  return Response.json({ success: true });
}
