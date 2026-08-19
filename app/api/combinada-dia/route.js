/**
 * GET /api/combinada-dia?date=YYYY-MM-DD
 *
 * Lee la apuesta del día guardada por el cron /api/cron/publish-combinada.
 * Si no se pasa date, usa la fecha de hoy.
 * Solo devuelve filas con status = 'published'.
 *
 * FORMATO: devuelve `data.matches`, un array con un máximo de DOS partidos
 * publicables y cada uno con `options` (entre 1 y 3 opciones). Ya no existe
 * `data.selections` plana ni
 * cuota/probabilidad combinadas. n8n debe recorrer `matches` y pedir una imagen
 * por partido a /api/pick-image?match=<JSON>.
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
import {
  isTelegramDailyPickOptionEligible,
  TELEGRAM_DAILY_PICK_RULES,
} from '../../../lib/telegram-daily-pick';

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

  // Filtro defensivo: descartar partidos que ya empezaron hace >110min y
  // opciones que ya no cumplan las reglas. El cron ya los filtra al
  // crear el snapshot, pero esto protege contra snapshots viejos del día (el
  // cron solo se re-corre 1x cada pocas horas y entre ejecuciones los partidos
  // cambian de NS a FT). Un partido que se quede sin opciones válidas deja de
  // ser publicable y se descarta entero.
  const nowMs = Date.now();
  const stored = Array.isArray(data.selections) ? data.selections : [];
  const matches = stored
    .map((match) => ({
      ...match,
      options: (Array.isArray(match?.options) ? match.options : [])
        .filter(option => isTelegramDailyPickOptionEligible(option))
        .slice(0, TELEGRAM_DAILY_PICK_RULES.maxOptionsPerMatch),
    }))
    .filter((match) => {
      if (match.options.length < TELEGRAM_DAILY_PICK_RULES.minOptionsPerMatch) return false;
      if (!match.kickoff) return true;
      const kickoffMs = new Date(match.kickoff).getTime();
      if (!Number.isFinite(kickoffMs)) return true;
      return (nowMs - kickoffMs) <= 110 * 60 * 1000;
    })
    .slice(0, TELEGRAM_DAILY_PICK_RULES.maxMatches);

  if (matches.length === 0) {
    return Response.json({ ok: false, reason: 'no publishable matches', date }, { status: 404 });
  }

  const { selections, combined_odd: _odd, combined_probability: _prob, ...rest } = data;
  return Response.json({ ok: true, data: { ...rest, matches } });
}
