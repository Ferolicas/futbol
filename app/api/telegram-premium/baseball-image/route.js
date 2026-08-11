/**
 * GET /api/telegram-premium/baseball-image?secret=CRON_SECRET[&date=YYYY-MM-DD]
 *
 * Tarjeta PNG del canal Picks Premium (béisbol): una sola imagen con todos los
 * juegos del día (fecha Bogotá) y todas sus opciones de carreras, hándicap,
 * hits, hits del bateador y ponches del lanzador (prob >= 60, fiab >= 90).
 * n8n la descarga como binario y la sube a Telegram.
 */

import {
  buildBaseballPremiumBoard,
  bogotaToday,
  BASEBALL_PREMIUM_RULES,
  BASEBALL_GROUP_LABELS,
} from '../../../../lib/telegram-premium-picks';
import { renderPremiumBoardPng } from '../../../../lib/premium-picks-image';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function verifyAuth(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret')
    || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(process.env.CRON_SECRET) && secret === process.env.CRON_SECRET;
}

function displayDate(isoDate) {
  const [year, month, day] = String(isoDate || '').split('-');
  return year && month && day ? `${day}/${month}/${year}` : '';
}

export async function GET(request) {
  if (!verifyAuth(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const date = url.searchParams.get('date') || bogotaToday();
    const board = await buildBaseballPremiumBoard(date);

    if (!board.matches.length) {
      return Response.json({ ok: false, reason: 'no eligible options', date }, { status: 404 });
    }

    const png = await renderPremiumBoardPng({
      title: 'PICKS PREMIUM · BÉISBOL',
      date: displayDate(board.fecha),
      matches: board.matches,
      groupOrder: BASEBALL_PREMIUM_RULES.groups,
      groupLabels: BASEBALL_GROUP_LABELS,
    });

    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[telegram-premium/baseball-image]', error);
    return Response.json({ error: 'No se pudo generar la imagen' }, { status: 500 });
  }
}
