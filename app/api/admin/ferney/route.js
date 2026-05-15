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
import { logAction } from '../../../../lib/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // calibration can take 20-30s on large prediction tables

async function requireAdmin() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('role, email')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || !['admin', 'owner'].includes(profile.role)) return null;
  return { ...user, email: profile.email || user.email };
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

/**
 * POST body shapes (action-routed):
 *   { action: 'retry',     queue, jobId }          → re-run a failed job
 *   { action: 'enqueue',   queue, payload }        → kick off a fresh job (e.g. force re-analysis)
 *   { action: 'calibrate', sport: 'futbol'|'baseball' }  → synchronous calibration (slow, up to ~30s)
 */
export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const cfg = workerConfig();
  if (!cfg) return Response.json({ error: 'worker not configured' }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const action = body?.action;

  // Calibration is potentially slow → longer timeout
  const isCalibrate = action === 'calibrate';
  const timeoutMs = isCalibrate ? 60_000 : 15_000;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let workerUrl;
    let workerBody;

    if (isCalibrate) {
      const sport = body.sport === 'baseball' ? 'baseball' : 'futbol';
      workerUrl = `${cfg.url}/admin/calibrate?sport=${sport}`;
      workerBody = '{}';
    } else if (action === 'retry' || action === 'enqueue') {
      if (!body.queue) return Response.json({ error: 'queue required' }, { status: 400 });
      workerUrl = `${cfg.url}/admin/retry`;
      workerBody = JSON.stringify({
        queue: body.queue,
        jobId: action === 'retry' ? body.jobId : undefined,
        payload: action === 'enqueue' ? body.payload : undefined,
      });
    } else {
      // Backwards-compat: legacy clients post { queue, jobId } directly
      if (!body.queue) return Response.json({ error: 'action required' }, { status: 400 });
      workerUrl = `${cfg.url}/admin/retry`;
      workerBody = JSON.stringify({ queue: body.queue, jobId: body.jobId });
    }

    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.secret}` },
      body: workerBody,
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await res.text();

    // Audit log fire-and-forget — solo si la accion fue aceptada por el worker.
    if (res.ok) {
      const auditAction = isCalibrate ? 'calibrate'
                        : action === 'retry' ? 'retry-job'
                        : action === 'enqueue' ? 'enqueue-job'
                        : 'retry-job';
      logAction({
        userId: user.id,
        userEmail: user.email,
        action: auditAction,
        entity: isCalibrate ? 'calibration' : 'queue',
        entityId: isCalibrate ? body.sport : body.queue,
        payload: isCalibrate
          ? { sport: body.sport || 'futbol' }
          : { queue: body.queue, jobId: body.jobId, payload: body.payload },
        request,
      }).catch(() => {});
    }

    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  } finally {
    clearTimeout(t);
  }
}
