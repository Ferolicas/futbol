/**
 * GET/POST /api/cron/publish-combinada?secret=CRON_SECRET[&date=YYYY-MM-DD][&status=draft|published]
 *
 * Recorre todos los partidos analizados del día y elige una apuesta publicable:
 * probabilidad y fiabilidad individual >=80%, únicamente goles/córners/
 * tarjetas/remates a puerta, cuota individual 1.20–1.60 y cuota total entre
 * 1.50 y 2.00. Prefiere una sola selección; si no alcanza el mínimo, combina
 * hasta tres partidos distintos sin bajar de 80% conjunto.
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
import { getAnalyzedFixtureIds, getAnalyzedMatchesFull } from '../../../../lib/sanity-cache';
import { jsonError } from '../../../../lib/api-error';
import { reliabilityPercent } from '../../../../lib/recommendation-policy';
import {
  selectTelegramDailyPick,
  TELEGRAM_DAILY_PICK_RULES,
} from '../../../../lib/telegram-daily-pick';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BETTABLE_STATUSES = new Set(['NS', 'TBD']);

function unwrapAnalysis(value) {
  if (!value || typeof value !== 'object') return {};
  if (value.analysis && typeof value.analysis === 'object'
      && (value.analysis.homeTeam || value.analysis.kickoff || value.analysis._scored)) {
    return value.analysis;
  }
  return value;
}

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

  // Telegram tiene una fiabilidad mínima propia de 80%, mientras el catálogo
  // público del frontend se sanea a 90%. Leemos aquí el documento durable
  // original para no perder opciones válidas 80–89%; la evidencia _scored
  // recupera la fiabilidad exacta en caches v20 que aún no la incluían dentro
  // de cada selección. Si la lectura durable falla, el fallback saneado sigue
  // siendo seguro porque es más estricto (>=90%).
  const rawResult = await supabaseAdmin
    .from('match_analysis')
    .select('fixture_id, analysis, combinada, cache_version')
    .eq('date', date)
    .gte('cache_version', 20)
    .in('fixture_id', fixtureIds);
  const rawRows = rawResult?.error ? [] : (rawResult?.data || []);
  const rawByFixture = new Map(rawRows.map((row) => {
    const inner = unwrapAnalysis(row.analysis);
    return [String(row.fixture_id), {
      combinada: row.combinada || inner.combinada || null,
      scored: inner._scored || row.analysis?._scored || {},
    }];
  }));

  // 3. Reunir candidatos de partidos que todavía no hayan empezado. La
  // selección final se hace de forma determinista al terminar la jornada.
  const nowMs = Date.now();
  const all = [];
  for (const [fid, data] of Object.entries(analyzedData || {})) {
    if (!data?.calculatedProbabilities) continue;
    const statusShort = data.status?.short || data.status;
    if (statusShort && !BETTABLE_STATUSES.has(statusShort)) continue;
    const kickoffMs = data.kickoff ? new Date(data.kickoff).getTime() : 0;
    if (kickoffMs > 0 && kickoffMs <= nowMs + 5 * 60 * 1000) continue;
    const raw = rawByFixture.get(String(fid));
    const combinada = raw?.combinada || data.combinada;
    if (combinada?.source !== 'context-engine') continue;
    const selections = combinada.selectable || combinada.selections || [];
    for (const sel of selections) {
      const evidence = raw?.scored?.[sel.id];
      const confidence = reliabilityPercent(sel.confidence ?? evidence?.confidence ?? evidence?.conf);
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
        confidence,
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

  // 4. Una sola selección si ya queda entre 1.50 y 1.60. Si no, buscar la
  // combinación mínima (máximo tres partidos distintos) entre 1.50 y 2.00.
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

  const publishedSelections = dailyPick.selections;

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
