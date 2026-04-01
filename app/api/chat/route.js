/**
 * /api/chat — Chat messages via Supabase.
 */
import { createSupabaseServerClient } from '../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../lib/supabase';
import { sendChatNotification } from '../../../lib/resend-email';
import { triggerEvent } from '../../../lib/pusher';

export const dynamic = 'force-dynamic';

// GET: Fetch chat messages
export async function GET(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabaseAdmin.from('user_profiles').select('role').eq('id', user.id).single();
  const isAdmin = profile?.role === 'admin';
  const { searchParams } = new URL(request.url);
  const targetUserId = searchParams.get('userId');

  try {
    if (isAdmin && !targetUserId) {
      const { data: messages, error: mErr } = await supabaseAdmin
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (mErr?.code === '42P01') return Response.json({ conversations: [] });

      const conversations = {};
      (messages || []).forEach(m => {
        if (!conversations[m.user_id]) {
          conversations[m.user_id] = { userId: m.user_id, userName: m.user_name, userEmail: m.user_email, messages: [], unreadCount: 0, lastMessage: null };
        }
        conversations[m.user_id].messages.push(m);
        if (!m.read && m.sender === 'user') conversations[m.user_id].unreadCount++;
        if (!conversations[m.user_id].lastMessage) conversations[m.user_id].lastMessage = m;
      });
      return Response.json({ conversations: Object.values(conversations) });
    }

    const queryUserId = isAdmin && targetUserId ? targetUserId : user.id;
    const { data: messages, error: mErr } = await supabaseAdmin
      .from('chat_messages')
      .select('id, message, sender, read, created_at')
      .eq('user_id', queryUserId)
      .order('created_at', { ascending: true });
    if (mErr?.code === '42P01') return Response.json({ messages: [] });

    return Response.json({ messages: messages || [] });
  } catch (error) {
    console.error('[chat:GET]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Send a chat message
export async function POST(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { message, targetUserId } = await request.json();
  if (!message?.trim()) return Response.json({ error: 'Message required' }, { status: 400 });

  const { data: profile } = await supabaseAdmin.from('user_profiles').select('role, name, email').eq('id', user.id).single();
  const isAdmin = profile?.role === 'admin';
  const sender = isAdmin ? 'agent' : 'user';
  const userId = isAdmin && targetUserId ? targetUserId : user.id;

  try {
    const { data: row, error } = await supabaseAdmin.from('chat_messages').insert({
      user_id: userId,
      user_name: profile?.name || user.email,
      user_email: profile?.email || user.email,
      message: message.trim(),
      sender,
      read: false,
      created_at: new Date().toISOString(),
    }).select('id').single();
    if (error) {
      if (error.code === '42P01') return Response.json({ error: 'Chat no disponible temporalmente.' }, { status: 503 });
      throw error;
    }

    await triggerEvent(`chat-${userId}`, 'new-message', { id: row.id, message: message.trim(), sender, created_at: new Date().toISOString() });

    if (sender === 'user') {
      await triggerEvent('chat-admin', 'new-message', { userId, userName: profile?.name, message: message.trim(), created_at: new Date().toISOString() });
      sendChatNotification({ userName: profile?.name || user.email, userEmail: profile?.email || user.email, message: message.trim() }).catch(() => {});
    }

    return Response.json({ success: true, id: row.id });
  } catch (error) {
    console.error('[chat:POST]', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// PATCH: Mark messages as read
export async function PATCH(request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { messageIds } = await request.json();
  if (!messageIds?.length) return Response.json({ success: true });

  const { error: readErr } = await supabaseAdmin.from('chat_messages').update({ read: true }).in('id', messageIds);
  if (readErr) console.error('[chat:PATCH]', readErr.message);
  return Response.json({ success: true });
}
