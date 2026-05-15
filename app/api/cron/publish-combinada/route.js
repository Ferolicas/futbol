/**
 * GET/POST /api/cron/publish-combinada?secret=CRON_SECRET[&date=YYYY-MM-DD][&status=draft|published]
 *
 * Recorre todos los partidos analizados del dia, reconstruye la combinada
 * con buildCombinada(), filtra >=90% probabilidad Y >=1.20 cuota, y guarda
 * el snapshot en la tabla `combinada_dia` (upsert por fecha).
 *
 * Status semantics:
 *   - 'draft'     = creada/calculada pero NO lista para publicar
 *   - 'published' = lista para mostrar al usuario (default cuando el cron termina ok)
 *
 * ⚠️ ARQUITECTURA — DOS TABLAS DISTINTAS, NO CONFUNDIR:
 *
 *   combinada_dia   ← ESTA tabla (escrita por este cron, leida solo por n8n)
 *     - Una fila por fecha (UNIQUE constraint en `fecha`).
 *     - Consumida exclusivamente por la automatizacion de n8n para
 *       publicar la apuesta del dia en Telegram.
 *     - El frontend NO la lee. /api/combinada-dia existe como lector,
 *       pero solo lo usa n8n.
 *
 *   combinadas      ← OTRA tabla (combinadas guardadas por usuario)
 *     - Multiples filas por usuario.
 *     - Escrita por /api/user (type=save-combinada).
 *     - Leida por el dashboard via hooks/useSavedCombinadas.
 *
 * El widget "Apuesta del Dia" del dashboard se calcula client-side en
 * app/dashboard/page.js (useMemo apuestaDelDia) iterando analyzedData,
 * no lee ninguna de las dos tablas. Cambios aqui NO afectan al frontend.
 */

import { supabaseAdmin } from '../../../../lib/supabase';
import { buildCombinada } from '../../../../lib/combinada';
import { getAnalyzedFixtureIds, getAnalyzedMatchesFull } from '../../../../lib/sanity-cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MIN_PROB = 90;
const MIN_ODD  = 1.20;
const VISUAL_PROB_CAP = 95; // no mostrar nunca 100% para no dar falsa certeza
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO', 'CANC', 'PST', 'ABD', 'SUSP']);

async function handle(request) {
  const url = new URL(request.url);
  const auth = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const secret = url.searchParams.get('secret') || auth;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const date   = url.searchParams.get('date')   || new Date().toISOString().split('T')[0];
  const statusParam = url.searchParams.get('status');
  const status = statusParam === 'draft' ? 'draft' : 'published';

  // 1. Fixtures analizados del dia
  const fixtureIds = await getAnalyzedFixtureIds(date).catch(() => []);
  if (!fixtureIds || fixtureIds.length === 0) {
    return Response.json({ ok: false, reason: 'no analyzed fixtures', date });
  }

  // 2. Cargar analisis completos (Redis L1 + Supabase L2)
  const { analyzedData } = await getAnalyzedMatchesFull(fixtureIds).catch(() => ({ analyzedData: {} }));

  // 3. Construir combinada por partido y juntar selecciones que cumplan thresholds
  const nowMs = Date.now();
  const all = [];
  for (const [fid, data] of Object.entries(analyzedData || {})) {
    if (!data?.calculatedProbabilities) continue;
    // Excluir partidos ya jugados o cancelados — la combinada del dia solo
    // debe contener selecciones que el usuario todavia puede apostar.
    const statusShort = data.status?.short || data.status;
    if (statusShort && FINISHED_STATUSES.has(statusShort)) continue;
    // Backup defensivo por si el status venia stale: kickoff + 110min de margen.
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
      if (sel.probability < MIN_PROB) continue;
      if (!sel.odd || sel.odd < MIN_ODD) continue;
      all.push({
        ...sel,
        fixtureId:    Number(fid),
        matchName:    `${data.homeTeam || '?'} vs ${data.awayTeam || '?'}`,
        homeTeam:     data.homeTeam || null,
        awayTeam:     data.awayTeam || null,
        league:       data.league   || null,
        kickoff:      data.kickoff  || null,
        probability:  Math.min(VISUAL_PROB_CAP, sel.probability),
      });
    }
  }

  if (all.length === 0) {
    return Response.json({
      ok: false,
      reason: 'no selections meet thresholds',
      date,
      analyzedCount: fixtureIds.length,
      thresholds: { minProb: MIN_PROB, minOdd: MIN_ODD },
    });
  }

  // 4. Ordenar: probabilidad desc, despues cuota desc
  all.sort((a, b) =>
    b.probability - a.probability ||
    (b.odd || 0) - (a.odd || 0)
  );

  const combinedOdd = all.reduce((acc, m) => acc * (m.odd || 1), 1);
  const combinedProbability = all.reduce((acc, m) => acc + m.probability, 0) / all.length;

  // 5. Upsert en combinada_dia (UNIQUE por fecha)
  const { data: row, error } = await supabaseAdmin
    .from('combinada_dia')
    .upsert({
      fecha: date,
      selections: all,
      combined_odd:         +combinedOdd.toFixed(2),
      combined_probability: +combinedProbability.toFixed(1),
      status,
    }, { onConflict: 'fecha' })
    .select()
    .single();

  if (error) {
    return Response.json({ ok: false, error: error.message, date }, { status: 500 });
  }

  return Response.json({
    ok: true,
    date,
    id: row.id,
    selections: all.length,
    combinedOdd:         +combinedOdd.toFixed(2),
    combinedProbability: +combinedProbability.toFixed(1),
    status,
    thresholds: { minProb: MIN_PROB, minOdd: MIN_ODD },
  });
}

export async function GET(request)  { return handle(request); }
export async function POST(request) { return handle(request); }
