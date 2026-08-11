/**
 * GET /api/telegram-premium/baseball-image?secret=CRON_SECRET[&date=YYYY-MM-DD][&fixture=ID]
 *
 * Tarjeta PNG del canal Picks Premium (béisbol) con las opciones de carreras,
 * hándicap, hits, hits del bateador y ponches del lanzador (prob >= 60,
 * fiab >= 90) del día Bogotá. Con `fixture` renderiza SOLO ese juego — n8n
 * publica una imagen por juego; sin él, el tablero completo.
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
    const fixture = url.searchParams.get('fixture');
    const board = await buildBaseballPremiumBoard(date);

    const matches = fixture
      ? board.matches.filter((match) => String(match.fixtureId) === String(fixture))
      : board.matches;
    if (!matches.length) {
      return Response.json({ ok: false, reason: 'no eligible options', date, fixture }, { status: 404 });
    }

    const png = await renderPremiumBoardPng({
      title: 'PICKS PREMIUM · BÉISBOL',
      date: displayDate(board.fecha),
      matches,
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
