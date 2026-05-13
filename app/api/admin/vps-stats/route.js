/**
 * GET /api/admin/vps-stats
 * Proxy al endpoint /stats del worker BullMQ. Requiere rol admin/owner.
 */
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

async function requireAdmin() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || !['admin', 'owner'].includes(profile.role)) return null;
  return user;
}

export async function GET() {
  const user = await requireAdmin();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const workerUrl = process.env.WORKER_URL?.replace(/\/$/, '');
  const workerSecret = process.env.WORKER_SECRET;
  if (!workerUrl || !workerSecret) {
    return Response.json({ error: 'WORKER_URL or WORKER_SECRET not configured' }, { status: 500 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${workerUrl}/stats`, {
      headers: { Authorization: `Bearer ${workerSecret}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return Response.json({ error: `worker_${res.status}` }, { status: 502 });
    }
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
