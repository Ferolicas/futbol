/**
 * GET /api/combinada-dia?date=YYYY-MM-DD
 *
 * Lee la combinada del día guardada por el cron /api/cron/publish-combinada.
 * Si no se pasa date, usa la fecha de hoy.
 * Solo devuelve filas con status = 'published'.
 */

import { supabaseAdmin } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];

  // Fetch by date only (no status filter in DB — avoids type coercion issues)
  const { data, error } = await supabaseAdmin
    .from('combinada_dia')
    .select('id, fecha, selections, combined_odd, combined_probability, status, created_at')
    .eq('fecha', date)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ ok: false, reason: 'not found', date }, { status: 404 });
  }

  if (data.status !== 'published') {
    return Response.json({ ok: false, reason: 'not published', status: data.status, date }, { status: 404 });
  }

  return Response.json({ ok: true, data });
}
