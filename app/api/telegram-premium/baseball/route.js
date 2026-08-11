/**
 * GET /api/telegram-premium/baseball?secret=CRON_SECRET[&date=YYYY-MM-DD]
 *
 * Feed JSON del canal Picks Premium (béisbol): todos los juegos del día (fecha
 * Bogotá, como el motor) aún no comenzados con TODAS sus opciones calculadas:
 * carreras (partido/equipo/primeras 5), hits, bateadores, abridores y
 * strikeouts con probabilidad >= 70 y fiabilidad >= 90, aunque todavía no
 * exista cuota.
 *
 * ⚠️ USO EXCLUSIVO DE n8n (workflow PICKS PREMIUM DIARIO). No lo llama el
 * frontend. Lee los análisis ya calculados; no dispara ningún motor.
 */

import { buildBaseballPremiumBoard, bogotaToday } from '../../../../lib/telegram-premium-picks';
import { jsonError } from '../../../../lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(process.env.CRON_SECRET) && secret === process.env.CRON_SECRET;
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const date = url.searchParams.get('date') || bogotaToday();
    const board = await buildBaseballPremiumBoard(date);

    if (!board.analyzedCount) {
      return Response.json({ ok: false, reason: 'no analyzed fixtures', date });
    }
    if (!board.matches.length) {
      return Response.json({
        ok: false,
        reason: 'no eligible options',
        date,
        analyzedCount: board.analyzedCount,
        rules: board.rules,
      });
    }

    return Response.json({ ok: true, data: board });
  } catch (error) {
    return jsonError(error);
  }
}
