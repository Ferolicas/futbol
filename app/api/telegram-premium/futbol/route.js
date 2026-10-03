import { isCronAuthorized } from '@/lib/internal-auth';
/**
 * GET /api/telegram-premium/futbol[?date=YYYY-MM-DD]
 * Authorization: Bearer CRON_SECRET
 *
 * Feed JSON del canal Picks Premium (fútbol): todos los partidos del día aún
 * no comenzados con TODAS sus opciones de hándicap, córners y goles que tengan
 * probabilidad >= 70 y fiabilidad >= 90.
 *
 * ⚠️ USO EXCLUSIVO DE n8n (workflow PICKS PREMIUM DIARIO). No lo llama el
 * frontend. Lee los análisis ya calculados; no dispara ningún motor.
 *
 * Respuestas siempre 200 para que n8n decida sin manejar errores HTTP:
 *   { ok: true,  data: { fecha, matches, totalOptions } }
 *   { ok: false, reason: 'no analyzed fixtures' | 'no eligible options' }
 */

import { buildFootballPremiumBoard, utcToday } from '../../../../lib/telegram-premium-picks';
import { jsonError } from '../../../../lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const date = url.searchParams.get('date') || utcToday();
    const board = await buildFootballPremiumBoard(date);

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
