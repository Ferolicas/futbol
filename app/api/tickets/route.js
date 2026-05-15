/**
 * /api/tickets — Support tickets via Supabase.
 */
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../lib/supabase';
import { sendTicketNotification } from '../../../lib/resend-email';
import { logAction } from '../../../lib/audit';

export const dynamic = 'force-dynamic';

// GET: List tickets
export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabaseAdmin.from('user_profiles').select('role, name, email').eq('id', user.id).single();
  const isAdmin = profile?.role === 'admin';

  try {
    let query = supabaseAdmin.from('tickets').select('*').order('created_at', { ascending: false });
    if (!isAdmin) query = query.eq('user_id', user.id);

    const { data, error } = await query;
    if (error) {
      if (error.code === '42P01') return Response.json({ tickets: [] }); // table not yet created
      throw error;
    }
    return Response.json({ tickets: data || [] });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Create a ticket or reply to one
export async function POST(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabaseAdmin.from('user_profiles').select('role, name, email').eq('id', user.id).single();
  const isAdmin = profile?.role === 'admin';
  const { message, ticketId: targetTicketId, reply } = await request.json();

  try {
    if (isAdmin && targetTicketId && reply) {
      const { error } = await supabaseAdmin
        .from('tickets')
        .update({ reply, status: 'replied', replied_at: new Date().toISOString() })
        .eq('ticket_id', targetTicketId);
      if (error) throw error;
      logAction({
        userId: user.id,
        userEmail: profile?.email || user.email,
        action: 'reply-ticket',
        entity: 'ticket',
        entityId: targetTicketId,
        payload: { reply_length: reply.length },
        request,
      }).catch(() => {});
      return Response.json({ success: true });
    }

    if (!message?.trim()) {
      return Response.json({ error: 'Message required' }, { status: 400 });
    }

    const { count } = await supabaseAdmin.from('tickets').select('*', { count: 'exact', head: true }).then(r => r).catch(() => ({ count: 0 }));
    const ticketId = `CFA_${1000 + (count || 0)}`;

    const { error } = await supabaseAdmin.from('tickets').insert({
      ticket_id: ticketId,
      user_id: user.id,
      user_name: profile?.name || user.email,
      user_email: profile?.email || user.email,
      message: message.trim(),
      status: 'open',
      created_at: new Date().toISOString(),
    });
    if (error) {
      if (error.code === '42P01') return Response.json({ error: 'Servicio no disponible. Intenta mas tarde.' }, { status: 503 });
      throw error;
    }

    sendTicketNotification({
      ticketId,
      message: message.trim(),
      userEmail: profile?.email || user.email,
      userName: profile?.name || user.email,
    }).catch(() => {});

    return Response.json({ success: true, ticketId });
  } catch (error) {
    console.error('[tickets]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
