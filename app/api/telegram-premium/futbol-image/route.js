/**
 * GET /api/telegram-premium/futbol-image?secret=CRON_SECRET[&date=YYYY-MM-DD][&fixture=ID]
 *
 * Tarjeta PNG del canal Picks Premium (fútbol) con las opciones de hándicap,
 * córners y goles (prob >= 70, fiab >= 90). Con `fixture` renderiza SOLO ese
 * partido — n8n publica una imagen por partido; sin él, el tablero completo.
 *
 * Protegida con CRON_SECRET porque renderiza datos del producto de pago; a
 * diferencia de /api/pick-image, aquí los datos salen de la base, no de la URL.
 */

import {
  buildFootballPremiumBoard,
  utcToday,
  FOOTBALL_PREMIUM_RULES,
  FOOTBALL_GROUP_LABELS,
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
    const date = url.searchParams.get('date') || utcToday();
    const fixture = url.searchParams.get('fixture');
    const board = await buildFootballPremiumBoard(date);

    const matches = fixture
      ? board.matches.filter((match) => String(match.fixtureId) === String(fixture))
      : board.matches;
    if (!matches.length) {
      return Response.json({ ok: false, reason: 'no eligible options', date, fixture }, { status: 404 });
    }

    const png = await renderPremiumBoardPng({
      title: 'PICKS PREMIUM · FÚTBOL',
      date: displayDate(board.fecha),
      matches,
      groupOrder: FOOTBALL_PREMIUM_RULES.groups,
      groupLabels: FOOTBALL_GROUP_LABELS,
    });

    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[telegram-premium/futbol-image]', error);
    return Response.json({ error: 'No se pudo generar la imagen' }, { status: 500 });
  }
}
