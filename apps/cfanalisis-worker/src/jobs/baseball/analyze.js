// @ts-nocheck
/**
 * Job: baseball-analyze
 * Port of /api/cron/baseball/analyze. Computes probs + combinada + data quality
 * for each game and persists baseball_match_analysis + baseball_match_predictions.
 *
 * Payload: { date?: string }
 */
import {
  getBaseballFixturesByDate, getBaseballOddsByGame, getBaseballTeamStats, getBaseballH2H, getBaseballQuota,
  getBaseballFixturePlayers, getBaseballPlayerStats,
  computeBaseballProbabilities, buildBaseballCombinada, scoreBaseballDataQuality, extractBestOdds,
  calibrateBaseballProbabilities, flattenProbabilitiesForStorage,
  extractBaseballPlayerHighlights, extractBaseballPitcherMatchup,
  supabaseAdmin,
} from '../../shared.js';
import { mapPool } from '../../pool.js';
import { logger } from '../../logger.js';

// Paralelismo igual que futbol-analyze-batch. API-Baseball comparte el rate
// limiter de api-baseball.js; más de ~10 paralelo solo bloquea CPU del motor.
const BASEBALL_ANALYZE_CONCURRENCY = 6;

// cache_version semantica:
//   1 = legacy (lo que habia antes del rework de baseball)
//   2 = post-rework: nuevo schema de probabilities con players + adaptive lines
const BASEBALL_CACHE_VERSION = 2;
const BASEBALL_MIN_CACHE_VERSION = 2;

/** @param {any} payload @param {any} [job] */
export async function runBaseballAnalyze(payload = {}, job = null) {
  // Misma lógica que futbol-daily: UTC con anticipo a "mañana" cuando ya
  // pasamos las 22 UTC. Debe coincidir con baseball-fixtures (mismo cálculo)
  // para que el analyze encuentre el schedule recién guardado.
  let date = payload.date;
  if (!date) {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const todayUTC    = now.toISOString().split('T')[0];
    const tomorrowUTC = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
    date = (utcHour >= 22 ? tomorrowUTC : todayUTC);
  }
  console.log(`[job:baseball-analyze] date=${date} force=${payload.force === true} concurrency=${BASEBALL_ANALYZE_CONCURRENCY}`);
  // force=true → ignora el check de cache_version + age, re-analiza todo.
  // Lo usa el boton "Analizar baseball" en /ferney para garantizar que
  // se vea trabajo aunque el cron diario ya haya procesado los partidos.
  const force = payload.force === true;
  const startedAt = Date.now();

  // Reporter de progreso para que /ferney muestre "processed/total" en vez
  // de "Sin datos de progreso". Mismo patron que futbol-analyze-batch.
  const reportProgress = async (extra) => {
    if (!job?.updateProgress) return;
    try { await job.updateProgress(extra); } catch {}
  };

  const { fixtures } = await getBaseballFixturesByDate(date);
  if (!fixtures || fixtures.length === 0) {
    await reportProgress({ phase: 'complete', processed: 0, total: 0, analyzed: 0, skipped: 0, failed: 0, startedAt });
    return { ok: true, analyzed: 0, message: 'no fixtures', date };
  }

  let analyzed = 0, skipped = 0, failed = 0, processed = 0, persistFailed = 0;
  const errors = [];
  // Flag compartida — si una task detecta cuota agotada, las demás abortan
  // su llamada API en lugar de seguir consumiendo. mapPool no tiene cancel
  // nativo, así que usamos esta señal.
  let quotaExhausted = false;

  await reportProgress({
    phase: 'analyzing', processed: 0, total: fixtures.length,
    analyzed: 0, skipped: 0, failed: 0, startedAt,
  });

  // Procesa UN partido. Devuelve {kind: 'analyzed'|'skipped'|'failed'|'aborted'}.
  // Nunca lanza — toda excepción se captura aquí para que mapPool no se rompa.
  async function processOne(game) {
    const fixtureId = game.id;
    if (quotaExhausted) return { kind: 'aborted', fixtureId };

    try {
      // Skip si ya está analizado recientemente con cache_version OK.
      if (!force) {
        const { data: existing } = await supabaseAdmin
          .from('baseball_match_analysis')
          .select('fixture_id, updated_at, cache_version')
          .eq('fixture_id', fixtureId)
          .maybeSingle();
        const ageMs = existing ? (Date.now() - new Date(existing.updated_at).getTime()) : Infinity;
        const versionOk = (existing?.cache_version || 0) >= BASEBALL_MIN_CACHE_VERSION;
        if (existing && ageMs < 6 * 3600 * 1000 && versionOk) {
          return { kind: 'skipped', fixtureId };
        }
      }

      // Chequeo de cuota antes de gastar la API en este partido. Si está baja,
      // marcamos la señal compartida y todos los siguientes abortan en seco.
      const quota = await getBaseballQuota();
      if (quota.remaining < 5) {
        console.log(`[job:baseball-analyze] quota low (${quota.remaining}), aborting subsequent fixtures`);
        quotaExhausted = true;
        return { kind: 'aborted', fixtureId };
      }

      const homeId = game.teams?.home?.id;
      const awayId = game.teams?.away?.id;
      const leagueId = game.league?.id;
      const homeName = game.teams?.home?.name;
      const awayName = game.teams?.away?.name;

      // 5 llamadas paralelas a la API por partido (rate-limiter compartido las
      // serializa internamente). Concurrencia=6 globalmente = ~30 calls/s burst,
      // pero el rate limiter en lib/api-baseball.js mantiene el ritmo seguro.
      const [oddsRes, h2hRes, homeStatsRes, awayStatsRes, fixturePlayersRes] = await Promise.allSettled([
        getBaseballOddsByGame(fixtureId),
        getBaseballH2H(homeId, awayId),
        getBaseballTeamStats(homeId, leagueId),
        getBaseballTeamStats(awayId, leagueId),
        getBaseballFixturePlayers(fixtureId),
      ]);
      const odds = oddsRes.status === 'fulfilled' ? oddsRes.value.odds : [];
      const h2h = h2hRes.status === 'fulfilled' ? h2hRes.value.h2h : [];
      const homeStats = homeStatsRes.status === 'fulfilled' ? homeStatsRes.value.stats : null;
      const awayStats = awayStatsRes.status === 'fulfilled' ? awayStatsRes.value.stats : null;
      const fixturePlayers = fixturePlayersRes.status === 'fulfilled' ? fixturePlayersRes.value : null;

      let pitcherMatchup = null;
      try {
        pitcherMatchup = await extractBaseballPitcherMatchup(fixturePlayers, homeId, awayId, leagueId, game.season);
      } catch (e) { console.warn(`[baseball-analyze] pitcherMatchup ${fixtureId}: ${e.message}`); }

      let playerHighlights = null;
      try {
        playerHighlights = await extractBaseballPlayerHighlights(fixturePlayers, homeId, awayId, homeName, awayName, leagueId, game.season);
      } catch (e) { console.warn(`[baseball-analyze] playerHighlights ${fixtureId}: ${e.message}`); }

      const rawProbs = computeBaseballProbabilities({
        homeStats, awayStats, homeId, awayId, h2h,
        marketOdds: odds, pitcherMatchup, playerHighlights,
      });
      const probs = await calibrateBaseballProbabilities(rawProbs);
      const bestOdds = extractBestOdds(odds);
      const combinada = buildBaseballCombinada(probs, bestOdds, { home: homeName, away: awayName });
      const dq = scoreBaseballDataQuality({ homeStats, awayStats, h2h, odds, pitcherMatchup, playerHighlights });

      // UPSERT principal. pgAdmin devuelve {error}, NO throw — lo leemos.
      const { error: upsertErr } = await supabaseAdmin.from('baseball_match_analysis').upsert({
        fixture_id: fixtureId,
        date,
        league_id: leagueId,
        league_name: game.league?.name,
        country: game.country?.name,
        home_team_id: homeId,
        away_team_id: awayId,
        home_team: homeName,
        away_team: awayName,
        status: game.status?.short || game.status?.long || 'NS',
        start_time: game.date,
        analysis: { homeStats, awayStats, h2h: h2h.slice(0, 10), pitcherMatchup, playerHighlights },
        odds,
        best_odds: bestOdds,
        probabilities: probs,
        combinada,
        data_quality: dq,
        cache_version: BASEBALL_CACHE_VERSION,
        updated_at: new Date().toISOString(),
      });
      if (upsertErr) {
        // No throw — tratamos como persist failure para que el job pueda
        // distinguir "cálculo OK pero BD falló" de "cálculo falló".
        console.error(`[baseball-analyze] PERSIST FALLÓ fid=${fixtureId}:`, upsertErr.message || upsertErr.code || upsertErr);
        return { kind: 'persist_failed', fixtureId, error: upsertErr.message || String(upsertErr) };
      }

      const { error: predErr } = await supabaseAdmin.from('baseball_match_predictions').upsert({
        fixture_id: fixtureId,
        date,
        league_id: leagueId,
        home_team_id: homeId,
        away_team_id: awayId,
        ...flattenProbabilitiesForStorage(probs),
        updated_at: new Date().toISOString(),
      });
      if (predErr) {
        console.warn(`[baseball-analyze] predictions fail (no critico) ${fixtureId}: ${predErr.message}`);
      }

      console.log(`[baseball-analyze] ✓ ${fixtureId} ${homeName} vs ${awayName} (dq=${dq?.score ?? '?'})`);
      return { kind: 'analyzed', fixtureId };
    } catch (e) {
      const msg = e?.message || String(e);
      const stack = e?.stack || null;
      logger.error({
        job: 'baseball-analyze',
        fixtureId,
        homeTeam: game.teams?.home?.name,
        awayTeam: game.teams?.away?.name,
        league: game.league?.name,
        err: msg,
        stack: stack?.split('\n').slice(0, 5).join('\n'),
      }, `fixture ${fixtureId} failed: ${msg}`);
      if (msg.startsWith('BASEBALL_QUOTA_EXHAUSTED')) quotaExhausted = true;
      return { kind: 'failed', fixtureId, error: msg, stack: stack?.split('\n')[0] };
    }
  }

  // mapPool: ANALYZE_CONCURRENCY tasks en vuelo a la vez. Cede el event loop
  // entre tasks (setImmediate) para que el lock renewer de BullMQ no se ahogue
  // — mismo patrón que futbol-analyze-batch.
  const results = await mapPool(fixtures, BASEBALL_ANALYZE_CONCURRENCY, async (game) => {
    const r = await processOne(game);
    // Actualizar contadores y progreso desde aquí (single-threaded JS, sin race).
    if (r.kind === 'analyzed')           analyzed++;
    else if (r.kind === 'skipped')       skipped++;
    else if (r.kind === 'persist_failed') { persistFailed++; errors.push({ fixtureId: r.fixtureId, error: r.error || 'persist' }); }
    else if (r.kind === 'failed')        { failed++; errors.push({ fixtureId: r.fixtureId, error: r.error || 'unknown', stack: r.stack }); }
    // 'aborted' → no se cuenta como ninguno (la cuota cortó el procesamiento).

    processed++;
    await reportProgress({
      phase: 'analyzing', processed, total: fixtures.length,
      analyzed, skipped, failed: failed + persistFailed, startedAt,
      firstError: errors[0]?.error || null,
    });
    await new Promise(r => setImmediate(r));
    return r;
  });
  void results;

  const quota = await getBaseballQuota();
  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const totalFails = failed + persistFailed;
  await reportProgress({
    phase: totalFails > 0 ? 'failed' : 'complete',
    processed: fixtures.length, total: fixtures.length,
    analyzed, skipped, failed: totalFails, startedAt,
    durationSec: Number(durationSec),
    firstError: errors[0]?.error || null,
  });

  // Summary log con persist counter separado para diagnóstico claro.
  const errorSummary = errors.slice(0, 5).map(e => `fid=${e.fixtureId}: ${e.error}`).join(' | ');
  logger.info({
    summary: 'baseball-analyze',
    date, total: fixtures.length, analyzed, skipped, failed, persistFailed,
    durationSec: Number(durationSec),
    firstErrors: errors.slice(0, 5),
  }, `baseball-analyze done — ${analyzed} ok, ${skipped} skipped, ${failed} failed, ${persistFailed} persist-failed in ${durationSec}s${errors.length > 0 ? ` | ${errorSummary}` : ''}`);

  // Si hubo fallos (cálculo o persistencia), throw → BullMQ reintenta. En el
  // reintento los análisis OK quedan skipped por el cache, así solo se
  // re-procesan los que fallaron. Mismo patrón que futbol-analyze-batch.
  if (totalFails > 0 && !quotaExhausted) {
    throw new Error(`baseball-analyze incomplete: ${failed} análisis + ${persistFailed} persist failures of ${fixtures.length}`);
  }

  return { ok: true, date, total: fixtures.length, analyzed, skipped, failed, persistFailed, durationSec: Number(durationSec), quota, errors: errors.slice(0, 5) };
}
