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

import { getAnalyzedFixtureIds, getAnalyzedMatchesFull } from '../../../lib/sanity-cache';
import { meetsFootballReliability } from '../../../lib/recommendation-policy';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO', 'CANC', 'PST', 'ABD', 'SUSP']);
const displayProbability = (value) => {
  const probability = Math.max(0, Math.min(100, Number(value) || 0));
  if (probability >= 95) return 95;
  return Math.floor((probability + 1e-9) * 100) / 100;
};

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

    if (data.combinada?.source !== 'context-engine') continue;
    const selections = data.combinada.selectable || data.combinada.selections || [];
    for (const sel of selections) {
      if (!meetsFootballReliability(sel.confidence)) continue;
      if (Number(sel.rawProbability ?? sel.probability) < minProb) continue;
      if (!sel.odd || sel.odd < minOdd) continue;
      all.push({
        ...sel,
        fixtureId:   Number(fid),
        matchName:   `${data.homeTeam || '?'} vs ${data.awayTeam || '?'}`,
        homeTeam:    data.homeTeam || null,
        awayTeam:    data.awayTeam || null,
        homeId:      data.homeId   || null,
        awayId:      data.awayId   || null,
        homeLogo:    data.homeLogo || null,
        awayLogo:    data.awayLogo || null,
        league:      data.league   || null,
        leagueId:    data.leagueId || null,
        leagueLogo:  data.leagueLogo || null,
        kickoff:     data.kickoff  || null,
        probability: displayProbability(sel.rawProbability ?? sel.probability),
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
    Number(b.rawProbability ?? b.probability) - Number(a.rawProbability ?? a.probability) ||
    (b.odd || 0) - (a.odd || 0)
  );

  const combinedOdd  = all.reduce((acc, m) => acc * (m.odd || 1), 1);
  const combinedProb = all.reduce((acc, m) => acc * (Number(m.rawProbability ?? m.probability) / 100), 1) * 100;

  return Response.json({
    ok: true,
    date,
    selections: all,
    combinedOdd:         +combinedOdd.toFixed(2),
    combinedProbability: displayProbability(combinedProb),
    rawCombinedProbability: +combinedProb.toFixed(2),
    selectionsCount:     all.length,
    thresholds:          { minProb, minOdd },
  });
}

export async function GET(request)  { return handle(request); }
export async function POST(request) { return handle(request); }
