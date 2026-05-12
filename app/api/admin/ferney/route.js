/**
 * GET /api/admin/ferney?date=YYYY-MM-DD
 *
 * Proxy that fetches the full /admin/status payload from the BullMQ worker
 * on the VPS and forwards it to the /ferney dashboard. Auth check is done
 * by middleware (admin/owner role required).
 *
 * Also supports POST { queue, jobId? } → /admin/retry to re-enqueue a job.
 */
import { createSupabaseServerClient } from '../../../../lib/supabase-auth';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

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

function workerConfig() {
  const url = process.env.WORKER_URL;
  const secret = process.env.WORKER_SECRET;
  if (!url || !secret) return null;
  return { url: url.replace(/\/$/, ''), secret };
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const cfg = workerConfig();
  if (!cfg) {
    return Response.json({ error: 'WORKER_URL or WORKER_SECRET not configured' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${cfg.url}/admin/status?date=${encodeURIComponent(date)}`, {
      headers: { Authorization: `Bearer ${cfg.secret}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return Response.json({ error: `worker_${res.status}`, body: text.slice(0, 500) }, { status: 502 });
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

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const cfg = workerConfig();
  if (!cfg) return Response.json({ error: 'worker not configured' }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const { queue, jobId } = body || {};
  if (!queue) return Response.json({ error: 'queue required' }, { status: 400 });

  try {
    const res = await fetch(`${cfg.url}/admin/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.secret}`,
      },
      body: JSON.stringify({ queue, jobId }),
      cache: 'no-store',
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}
