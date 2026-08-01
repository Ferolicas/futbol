/**
 * GET/POST /api/cron/publish-combinada?secret=CRON_SECRET[&date=YYYY-MM-DD][&status=draft|published]
 *
 * Recorre todos los partidos analizados del día y elige una apuesta publicable:
 * probabilidad individual >=90%, únicamente goles/córners/tarjetas/remates a
 * puerta y cuota total entre 1.50 y 2.00. Prefiere una sola selección; si no
 * alcanza el mínimo, combina hasta tres partidos distintos.
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
import { jsonError } from '../../../../lib/api-error';
import {
  selectTelegramDailyPick,
  TELEGRAM_DAILY_PICK_RULES,
} from '../../../../lib/telegram-daily-pick';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CONTEXT_ENGINE_ENABLED = process.env.CONTEXT_ENGINE_ENABLED === 'true';
const VISUAL_PROB_CAP = 95; // no mostrar nunca 100% para no dar falsa certeza
const BETTABLE_STATUSES = new Set(['NS', 'TBD']);

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

  // 3. Reunir candidatos de partidos que todavía no hayan empezado. La selección
  // final (mercados permitidos y cuota 1.50–2.00) se hace de forma determinista
  // al terminar de recorrer la jornada.
  const nowMs = Date.now();
  const all = [];
  for (const [fid, data] of Object.entries(analyzedData || {})) {
    if (!data?.calculatedProbabilities) continue;
    const statusShort = data.status?.short || data.status;
    if (statusShort && !BETTABLE_STATUSES.has(statusShort)) continue;
    const kickoffMs = data.kickoff ? new Date(data.kickoff).getTime() : 0;
    if (kickoffMs > 0 && kickoffMs <= nowMs + 5 * 60 * 1000) continue;
    // La combinada del motor trae candidatos desde 80% y cuota ≥1.20. La
    // selección final de Telegram aplica aquí el requisito estricto de 90%.
    let selections;
    if (CONTEXT_ENGINE_ENABLED && data.combinada?.source === 'context-engine') {
      selections = data.combinada.selections || [];
    } else {
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
      selections = comb?.selections || [];
    }
    for (const sel of selections) {
      all.push({
        ...sel,
        fixtureId:    Number(fid),
        matchName:    `${data.homeTeam || '?'} vs ${data.awayTeam || '?'}`,
        homeTeam:     data.homeTeam || null,
        awayTeam:     data.awayTeam || null,
        homeId:       data.homeId   || null,
        awayId:       data.awayId   || null,
        homeLogo:     data.homeLogo || null,
        awayLogo:     data.awayLogo || null,
        league:       data.league   || null,
        leagueId:     data.leagueId || null,
        leagueLogo:   data.leagueLogo || null,
        kickoff:      data.kickoff  || null,
        probability:  Number(sel.probability),
      });
    }
  }

  if (all.length === 0) {
    return Response.json({
      ok: false,
      reason: 'no analyzed selections',
      date,
      analyzedCount: fixtureIds.length,
      rules: TELEGRAM_DAILY_PICK_RULES,
    });
  }

  // 4. Una sola selección si ya queda entre 1.50 y 2.00. Si no, buscar la
  // combinación mínima (máximo tres partidos distintos) que entre en el rango.
  const dailyPick = selectTelegramDailyPick(all);
  if (dailyPick.selections.length === 0) {
    return Response.json({
      ok: false,
      reason: 'no allowed combination in target odds',
      date,
      analyzedCount: fixtureIds.length,
      eligibleCount: dailyPick.eligibleCount,
      rules: TELEGRAM_DAILY_PICK_RULES,
    });
  }

  const publishedSelections = dailyPick.selections.map(selection => ({
    ...selection,
    probability: Math.min(VISUAL_PROB_CAP, selection.probability),
  }));

  // 5. Upsert en combinada_dia (UNIQUE por fecha)
  const { data: row, error } = await supabaseAdmin
    .from('combinada_dia')
    .upsert({
      fecha: date,
      selections: publishedSelections,
      combined_odd:         dailyPick.combinedOdd,
      combined_probability: dailyPick.combinedProbability,
      status,
    }, { onConflict: 'fecha' })
    .select()
    .single();

  if (error) {
    return jsonError(error);
  }

  return Response.json({
    ok: true,
    date,
    id: row.id,
    selections: publishedSelections.length,
    combinedOdd:         dailyPick.combinedOdd,
    combinedProbability: dailyPick.combinedProbability,
    status,
    eligibleCount: dailyPick.eligibleCount,
    rules: TELEGRAM_DAILY_PICK_RULES,
    data: {
      fecha: row.fecha,
      selections: publishedSelections,
      combinedOdd: dailyPick.combinedOdd,
      combinedProbability: dailyPick.combinedProbability,
      status,
    },
  });
}

export async function GET(request)  { return handle(request); }
export async function POST(request) { return handle(request); }
