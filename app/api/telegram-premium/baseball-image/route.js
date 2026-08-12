/**
 * GET /api/telegram-premium/baseball-image?secret=CRON_SECRET&fixture=ID[&date=YYYY-MM-DD][&page=N]
 *
 * PNG 16:9 del canal Picks Premium (béisbol). Cada partido se representa en
 * una única imagen horizontal con todas las tarjetas necesarias distribuidas
 * automáticamente en filas y columnas.
 */

import {
  buildBaseballPremiumBoard,
  bogotaToday,
  BASEBALL_PREMIUM_RULES,
  BASEBALL_GROUP_LABELS,
} from '../../../../lib/telegram-premium-picks';
import { buildBaseballMosaicPages } from '../../../../lib/baseball-premium-mosaic-layout';
import { renderBaseballPremiumMosaicPng } from '../../../../lib/baseball-premium-mosaic-image';
import { runBaseballPremiumRenderExclusive } from '../../../../lib/baseball-premium-render-queue';

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
    const requestedPage = Number(url.searchParams.get('page') || 1);
    if (!fixture) {
      return Response.json({ ok: false, reason: 'fixture is required', date }, { status: 400 });
    }
    if (!Number.isInteger(requestedPage) || requestedPage < 1) {
      return Response.json({ ok: false, reason: 'invalid page', date, fixture }, { status: 400 });
    }
    const board = await buildBaseballPremiumBoard(date);

    const match = board.matches.find((item) => String(item.fixtureId) === String(fixture));
    if (!match) {
      return Response.json({ ok: false, reason: 'no eligible options', date, fixture }, { status: 404 });
    }
    const pages = buildBaseballMosaicPages(
      match,
      BASEBALL_PREMIUM_RULES.groups,
      BASEBALL_GROUP_LABELS,
    );
    const page = pages[requestedPage - 1];
    if (!page) {
      return Response.json({
        ok: false,
        reason: 'page not found',
        date,
        fixture,
        pages: pages.length,
      }, { status: 404 });
    }

    const png = await runBaseballPremiumRenderExclusive(() => (
      renderBaseballPremiumMosaicPng({
        match,
        date: displayDate(board.fecha),
        page,
      })
    ));

    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="cf-premium-baseball-${fixture}.png"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Mosaic-Resolution': '3840x2160',
        'X-Mosaic-Page': String(page.page),
        'X-Mosaic-Pages': String(page.pages),
        'X-Mosaic-Cards': String(page.cards.length),
      },
    });
  } catch (error) {
    console.error('[telegram-premium/baseball-image]', error);
    return Response.json({ error: 'No se pudo generar la imagen' }, { status: 500 });
  }
}
