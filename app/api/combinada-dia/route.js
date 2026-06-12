/**
 * GET /api/combinada-dia?date=YYYY-MM-DD
 *
 * Lee la combinada del día guardada por el cron /api/cron/publish-combinada.
 * Si no se pasa date, usa la fecha de hoy.
 * Solo devuelve filas con status = 'published'.
 *
 * ⚠️ USO EXCLUSIVO DE n8n — NO LO LLAMA EL FRONTEND.
 *
 * El widget "Apuesta del Dia" del dashboard se calcula client-side en
 * app/dashboard/page.js (useMemo apuestaDelDia) sobre analyzedData, sin
 * pasar por esta tabla. Este endpoint existe unicamente como fuente para
 * la automatizacion de n8n que publica la apuesta del dia en Telegram.
 *
 * Tabla consultada: combinada_dia (una fila por fecha, escrita por el
 * cron publish-combinada). NO confundir con la tabla `combinadas`, que
 * almacena las combinadas que cada usuario guarda manualmente y se lee
 * desde /api/user?type=combinadas.
 */

import { supabaseAdmin } from '../../../lib/supabase';
import { jsonError } from '../../../lib/api-error';

export const dynamic = 'force-dynamic';

// Endpoint de uso EXCLUSIVO de n8n (no lo llama el frontend). Se protege con
// CRON_SECRET — mismo secreto que el resto de crons y que n8n ya envía a
// /api/cron/publish-combinada — vía ?secret= o `Authorization: Bearer`.
// Antes era público: cualquiera podía leer la combinada del día en crudo.
function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace('Bearer ', '');
  return Boolean(process.env.CRON_SECRET) && secret === process.env.CRON_SECRET;
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
    return jsonError(error);
  }

  if (!data) {
    return Response.json({ ok: false, reason: 'not found', date }, { status: 404 });
  }

  if (data.status !== 'published') {
    return Response.json({ ok: false, reason: 'not published', status: data.status, date }, { status: 404 });
  }

  // Filtro defensivo: descartar selecciones cuyo partido ya empezo hace >110min.
  // El cron publish-combinada ya las filtra al crear el snapshot, pero esto
  // protege contra snapshots viejos del dia (el cron solo se re-corre 1x cada
  // pocas horas y entre ejecuciones partidos cambian de NS a FT).
  if (Array.isArray(data.selections)) {
    const nowMs = Date.now();
    data.selections = data.selections.filter(sel => {
      if (!sel?.kickoff) return true;
      const kMs = new Date(sel.kickoff).getTime();
      if (!Number.isFinite(kMs)) return true;
      return (nowMs - kMs) <= 110 * 60 * 1000;
    });
  }

  return Response.json({ ok: true, data });
}
