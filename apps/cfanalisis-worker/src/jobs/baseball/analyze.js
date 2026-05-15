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
import { logger } from '../../logger.js';

// cache_version semantica:
//   1 = legacy (lo que habia antes del rework de baseball)
//   2 = post-rework: nuevo schema de probabilities con players + adaptive lines
const BASEBALL_CACHE_VERSION = 2;
const BASEBALL_MIN_CACHE_VERSION = 2;

export async function runBaseballAnalyze(payload = {}, job = null) {
  const date = payload.date || new Date().toISOString().split('T')[0];
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

  let analyzed = 0, skipped = 0, failed = 0, processed = 0;
  const errors = [];

  await reportProgress({
    phase: 'analyzing', processed: 0, total: fixtures.length,
    analyzed: 0, skipped: 0, failed: 0, startedAt,
  });

  for (const game of fixtures) {
    const fixtureId = game.id;
    try {
      // Skip si ya esta analizado recientemente con la version correcta.
      // force=true salta el check — re-analiza todo (botón manual /ferney).
      if (!force) {
        const { data: existing } = await supabaseAdmin
          .from('baseball_match_analysis')
          .select('fixture_id, updated_at, cache_version')
          .eq('fixture_id', fixtureId)
          .maybeSingle();
        const ageMs = existing ? (Date.now() - new Date(existing.updated_at).getTime()) : Infinity;
        const versionOk = (existing?.cache_version || 0) >= BASEBALL_MIN_CACHE_VERSION;
        if (existing && ageMs < 6 * 3600 * 1000 && versionOk) {
          skipped++;
          processed++;
          await reportProgress({ phase: 'analyzing', processed, total: fixtures.length, analyzed, skipped, failed, startedAt });
          continue;
        }
      }

      const quota = await getBaseballQuota();
      if (quota.remaining < 5) {
        console.log(`[job:baseball-analyze] quota low (${quota.remaining}), stopping`);
        break;
      }

      const homeId = game.teams?.home?.id;
      const awayId = game.teams?.away?.id;
      const leagueId = game.league?.id;

      const homeName = game.teams?.home?.name;
      const awayName = game.teams?.away?.name;

      // Llamadas paralelas. fixturePlayersRes = /fixtures/players (bloque E),
      // necesario para extraer starting pitcher + roster con stats.
      const [oddsRes, h2hRes, homeStatsRes, awayStatsRes, fixturePlayersRes] = await Promise.allSettled([
        getBaseballOddsByGame(fixtureId),
        getBaseballH2H(homeId, awayId),
        getBaseballTeamStats(homeId, leagueId),
        getBaseballTeamStats(awayId, leagueId),
        getBaseballFixturePlayers(fixtureId),  // bloque E
      ]);

      const odds = oddsRes.status === 'fulfilled' ? oddsRes.value.odds : [];
      const h2h = h2hRes.status === 'fulfilled' ? h2hRes.value.h2h : [];
      const homeStats = homeStatsRes.status === 'fulfilled' ? homeStatsRes.value.stats : null;
      const awayStats = awayStatsRes.status === 'fulfilled' ? awayStatsRes.value.stats : null;
      const fixturePlayers = fixturePlayersRes.status === 'fulfilled' ? fixturePlayersRes.value : null;

      // Bloque E — extraer starting pitchers + sus stats. Si falla, el modelo
      // sigue funcionando sin pitcher matchup (vuelve al estimado por team stats).
      let pitcherMatchup = null;
      try {
        pitcherMatchup = await extractBaseballPitcherMatchup(fixturePlayers, homeId, awayId, leagueId, game.season);
      } catch (e) {
        console.warn(`[baseball-analyze] pitcherMatchup ${fixtureId}: ${e.message}`);
      }

      // Bloque F — extraer player highlights (top batters por ofensive output).
      let playerHighlights = null;
      try {
        playerHighlights = await extractBaseballPlayerHighlights(fixturePlayers, homeId, awayId, homeName, awayName, leagueId, game.season);
      } catch (e) {
        console.warn(`[baseball-analyze] playerHighlights ${fixtureId}: ${e.message}`);
      }

      const rawProbs = computeBaseballProbabilities({
        homeStats, awayStats, homeId, awayId, h2h,
        marketOdds: odds,
        pitcherMatchup,         // bloque E
        playerHighlights,       // bloque F (alimenta probabilities.players)
      });
      const probs = await calibrateBaseballProbabilities(rawProbs);

      const bestOdds = extractBestOdds(odds);
      const combinada = buildBaseballCombinada(probs, bestOdds, { home: homeName, away: awayName });
      const dq = scoreBaseballDataQuality({ homeStats, awayStats, h2h, odds, pitcherMatchup, playerHighlights });

      // Upsert principal — capturar el error de DB explicitamente para
      // que aparezca en el array `errors` y se vea en /ferney. Si la
      // columna cache_version o cualquier otra falta, el upsert lanza
      // PG error 42703 "column X does not exist".
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
        throw new Error(`DB upsert match_analysis: ${upsertErr.message || upsertErr.code || upsertErr}`);
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

      analyzed++;
    } catch (e) {
      const msg = e?.message || String(e);
      const stack = e?.stack || null;
      // Pino structured log con campos para filtrar facilmente con jq
      // sobre /var/log/cfanalisis/worker.log:
      //   grep '"job":"baseball-analyze"' worker.log | jq '.fixtureId, .err'
      logger.error({
        job: 'baseball-analyze',
        fixtureId,
        homeTeam: game.teams?.home?.name,
        awayTeam: game.teams?.away?.name,
        league: game.league?.name,
        err: msg,
        stack: stack?.split('\n').slice(0, 5).join('\n'),
      }, `fixture ${fixtureId} failed: ${msg}`);
      failed++;
      errors.push({ fixtureId, error: msg, stack: stack?.split('\n')[0] });
      if (msg.startsWith('BASEBALL_QUOTA_EXHAUSTED')) break;
    }
    processed++;
    // Reportar tras cada partido para que /ferney refleje progreso en vivo.
    // Incluye `firstError` para que el panel muestre la razon concreta del
    // fallo sin tener que ir a logs del worker.
    await reportProgress({
      phase: 'analyzing', processed, total: fixtures.length,
      analyzed, skipped, failed, startedAt,
      firstError: errors[0]?.error || null,
    });
  }

  const quota = await getBaseballQuota();
  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  await reportProgress({
    phase: failed > 0 ? 'failed' : 'complete',
    processed: fixtures.length, total: fixtures.length,
    analyzed, skipped, failed, startedAt,
    durationSec: Number(durationSec),
    firstError: errors[0]?.error || null,
  });

  // Summary log al final del job — buscar en logs con:
  //   grep '"summary":"baseball-analyze"' /var/log/cfanalisis/worker.log
  const errorSummary = errors.slice(0, 5).map(e => `fid=${e.fixtureId}: ${e.error}`).join(' | ');
  logger.info({
    summary: 'baseball-analyze',
    date, total: fixtures.length, analyzed, skipped, failed,
    durationSec: Number(durationSec),
    firstErrors: errors.slice(0, 5),
  }, `baseball-analyze done — ${analyzed} ok, ${skipped} skipped, ${failed} failed in ${durationSec}s${errors.length > 0 ? ` | ${errorSummary}` : ''}`);

  return { ok: true, date, total: fixtures.length, analyzed, skipped, failed, durationSec: Number(durationSec), quota, errors: errors.slice(0, 5) };
}
