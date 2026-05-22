/**
 * GET /api/combinada-alta?secret=CRON_SECRET[&date=YYYY-MM-DD][&minProb=80][&minOdd=1.20]
 *
 * Calcula la combinada de selecciones >= minProb y >= minOdd para `date`
 * (default = hoy hora Colombia). NO guarda nada — solo devuelve JSON.
 *
 * Usado por n8n para enviar a Telegram personal una combinada de
 * probabilidad alta (default 80%) sin pisar la tabla combinada_dia
 * (que es exclusiva del workflow "apuesta del dia" con 90%+).
 */

import { buildCombinada } from '../../../lib/combinada';
import { getAnalyzedFixtureIds, getAnalyzedMatchesFull } from '../../../lib/sanity-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const VISUAL_PROB_CAP = 95;
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO', 'CANC', 'PST', 'ABD', 'SUSP']);

function todayInBogota() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

async function handle(request) {
  const url = new URL(request.url);
  const auth = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const secret = url.searchParams.get('secret') || auth;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const date    = url.searchParams.get('date')    || todayInBogota();
  const minProb = Number(url.searchParams.get('minProb') ?? 80);
  const minOdd  = Number(url.searchParams.get('minOdd')  ?? 1.20);

  const fixtureIds = await getAnalyzedFixtureIds(date).catch(() => []);
  if (!fixtureIds || fixtureIds.length === 0) {
    return Response.json({ ok: true, date, selections: [], reason: 'no analyzed fixtures' });
  }

  const { analyzedData } = await getAnalyzedMatchesFull(fixtureIds).catch(() => ({ analyzedData: {} }));

  const nowMs = Date.now();
  const all = [];
  for (const [fid, data] of Object.entries(analyzedData || {})) {
    if (!data?.calculatedProbabilities) continue;
    const statusShort = data.status?.short || data.status;
    if (statusShort && FINISHED_STATUSES.has(statusShort)) continue;
    const kickoffMs = data.kickoff ? new Date(data.kickoff).getTime() : 0;
    if (kickoffMs > 0 && (nowMs - kickoffMs) > 110 * 60 * 1000) continue;

    let comb;
    try {
      comb = buildCombinada(
        data.calculatedProbabilities,
        data.odds,
        data.playerHighlights,
        { home: data.homeTeam, away: data.awayTeam }
      );
    } catch {
      continue;
    }
    const selections = comb?.selections || [];
    for (const sel of selections) {
      if (sel.probability < minProb) continue;
      if (!sel.odd || sel.odd < minOdd) continue;
      all.push({
        ...sel,
        fixtureId:   Number(fid),
        matchName:   `${data.homeTeam || '?'} vs ${data.awayTeam || '?'}`,
        homeTeam:    data.homeTeam || null,
        awayTeam:    data.awayTeam || null,
        league:      data.league   || null,
        kickoff:     data.kickoff  || null,
        probability: Math.min(VISUAL_PROB_CAP, sel.probability),
      });
    }
  }

  if (all.length === 0) {
    return Response.json({
      ok: true, date, selections: [],
      reason: 'no selections meet thresholds',
      analyzedCount: fixtureIds.length,
      thresholds: { minProb, minOdd },
    });
  }

  all.sort((a, b) =>
    b.probability - a.probability ||
    (b.odd || 0) - (a.odd || 0)
  );

  const combinedOdd  = all.reduce((acc, m) => acc * (m.odd || 1), 1);
  const combinedProb = all.reduce((acc, m) => acc * ((m.probability || 0) / 100), 1) * 100;

  return Response.json({
    ok: true,
    date,
    selections: all,
    combinedOdd:         +combinedOdd.toFixed(2),
    combinedProbability: +combinedProb.toFixed(1),
    selectionsCount:     all.length,
    thresholds:          { minProb, minOdd },
  });
}

export async function GET(request)  { return handle(request); }
export async function POST(request) { return handle(request); }
