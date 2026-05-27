// @ts-nocheck
/**
 * Job: baseball-analyze (MLB-only, MLB Stats API)
 *
 * Reescrito para usar la MLB Stats API oficial (statsapi.mlb.com) como fuente
 * principal — api-baseball no tiene pitchers ni temporada actual (plan free).
 * Cuotas desde The Odds API (baseball_mlb). El pitcher abridor es el factor #1
 * que hace que el modelo discrimine (favoritos 60-73% en vez de ~50% plano).
 *
 * Por juego:
 *   - schedule + probable pitchers   ← MLB Stats API
 *   - factor de pitcher (ERA/WHIP/K9) ← MLB Stats API (getMlbPitcherMatchup)
 *   - stats de equipo (runs F/C)      ← MLB Stats API (getMlbTeamSeasonStats)
 *   - cuotas (moneyline/totals/runline) ← The Odds API (matchMlbOdds)
 *   - probabilidades + combinada + persistencia (mismas tablas de siempre)
 *
 * Payload: { date?: 'YYYY-MM-DD', force?: boolean, sportId?: 1|11|12 }
 */
import {
  getMlbScheduleByDate, getMlbPitcherMatchup, getMlbTeamSeasonStats, toModelTeamStats,
  fetchMlbOddsByDate, matchMlbOdds,
  computeBaseballProbabilities, buildBaseballCombinada, scoreBaseballDataQuality,
  calibrateBaseballProbabilities, flattenProbabilitiesForStorage,
  extractBaseballPlayerHighlights,
  supabaseAdmin, cronTargetDate, bogotaToday,
} from '../../shared.js';
import { mapPool } from '../../pool.js';
import { logger } from '../../logger.js';

const BASEBALL_ANALYZE_CONCURRENCY = 5;
const BASEBALL_CACHE_VERSION = 3;       // 3 = MLB Stats API + pitcher factor
const BASEBALL_MIN_CACHE_VERSION = 3;

// sportIds a analizar: 1=MLB. (MiLB 11/12 se pueden añadir; el usuario pidió
// 1ª y 2ª división — empezamos por MLB y se amplía cambiando este array.)
const SPORT_IDS = [1];

// Convierte las cuotas normalizadas de The Odds API al `bestOdds` que consume
// buildBaseballCombinada (totals con {odd}, moneyline/runLine valores directos).
function toBestOdds(odds) {
  if (!odds) return { moneyline: null, totals: {}, runLine: null };
  const totals = {};
  for (const [line, v] of Object.entries(odds.totals || {})) {
    totals[line] = {
      over:  v.over  != null ? { odd: v.over }  : null,
      under: v.under != null ? { odd: v.under } : null,
    };
  }
  return {
    moneyline: odds.moneyline || null,
    totals,
    runLine: odds.runLine || null,
  };
}

/** @param {any} payload @param {any} [job] */
export async function runBaseballAnalyze(payload = {}, job = null) {
  // Fecha objetivo:
  //  - normal (cron nocturno): cronTargetDate() = jornada Colombia que arranca.
  //  - pre-partido (payload.today): bogotaToday() = día Colombia EN CURSO. Lo usa
  //    el re-análisis de la tarde para capturar el lineup confirmado (props de
  //    bateadores) de los partidos que se juegan HOY — cronTargetDate apuntaría
  //    a mañana tras el mediodía Colombia, día equivocado para esto.
  //  - explícito: payload.date manda.
  const date = payload.date || (payload.today ? bogotaToday() : cronTargetDate());
  const force = payload.force === true;
  const season = Number(date.slice(0, 4));
  const startedAt = Date.now();
  console.log(`[job:baseball-analyze] MLB date=${date} season=${season} force=${force}`);

  const reportProgress = async (extra) => {
    if (!job?.updateProgress) return;
    try { await job.updateProgress(extra); } catch {}
  };

  // 1) Schedule de todos los sportIds + cuotas del día (1 sola llamada a odds).
  let games = [];
  for (const sportId of SPORT_IDS) {
    try {
      const g = await getMlbScheduleByDate(date, sportId);
      games.push(...g.map(x => ({ ...x, sportId })));
    } catch (e) {
      console.warn(`[baseball-analyze] schedule sportId=${sportId}: ${e.message}`);
    }
  }
  if (games.length === 0) {
    await reportProgress({ phase: 'complete', processed: 0, total: 0, analyzed: 0, skipped: 0, failed: 0, startedAt });
    return { ok: true, analyzed: 0, message: 'no games', date };
  }

  let oddsByTeams = {};
  try {
    const r = await fetchMlbOddsByDate();
    oddsByTeams = r.byTeams || {};
    console.log(`[baseball-analyze] odds MLB: ${Object.keys(oddsByTeams).length} juegos con cuotas (quota restante ${r.remaining})`);
  } catch (e) {
    console.warn(`[baseball-analyze] fetchMlbOddsByDate: ${e.message}`);
  }

  let analyzed = 0, skipped = 0, failed = 0, processed = 0, persistFailed = 0;
  const errors = [];

  await reportProgress({ phase: 'analyzing', processed: 0, total: games.length, analyzed: 0, skipped: 0, failed: 0, startedAt });

  async function processOne(game) {
    const fixtureId = game.gamePk;
    try {
      // Skip si ya analizado reciente con cache_version OK.
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

      const homeName = game.home?.name;
      const awayName = game.away?.name;

      // Datos en paralelo: pitcher matchup + stats de equipos + player props.
      const [matchup, homeTeamRaw, awayTeamRaw, playerHighlights] = await Promise.all([
        getMlbPitcherMatchup(game, season).catch(() => null),
        getMlbTeamSeasonStats(game.home?.id, season, game.sportId).catch(() => null),
        getMlbTeamSeasonStats(game.away?.id, season, game.sportId).catch(() => null),
        extractBaseballPlayerHighlights(game, season).catch(() => null),
      ]);
      const homeStats = toModelTeamStats(homeTeamRaw);
      const awayStats = toModelTeamStats(awayTeamRaw);

      // Cuotas del juego (The Odds API) por nombre de equipo.
      const odds = matchMlbOdds(oddsByTeams, homeName, awayName);
      const bestOdds = toBestOdds(odds);
      const marketMoneyline = odds?.moneyline || null;

      const rawProbs = computeBaseballProbabilities({
        homeStats, awayStats, homeId: game.home?.id, awayId: game.away?.id,
        h2h: [], marketMoneyline, pitcherMatchup: matchup, playerHighlights,
      });
      const probs = await calibrateBaseballProbabilities(rawProbs);
      const combinada = buildBaseballCombinada(probs, bestOdds, { home: homeName, away: awayName });
      const dq = scoreBaseballDataQuality({
        homeStats, awayStats, h2h: [], odds: odds ? [odds] : [],
        pitcherMatchup: matchup, playerHighlights,
      });

      const { error: upsertErr } = await supabaseAdmin.from('baseball_match_analysis').upsert({
        fixture_id: fixtureId,
        date,
        league_id: game.sportId === 1 ? 1 : game.sportId,
        league_name: game.sportId === 1 ? 'MLB' : `MiLB (${game.sportId})`,
        country: 'USA',
        home_team_id: game.home?.id,
        away_team_id: game.away?.id,
        home_team: homeName,
        away_team: awayName,
        status: game.status || (game.isFinal ? 'Final' : 'Scheduled'),
        start_time: game.dateUTC,
        analysis: { homeStats, awayStats, pitcherMatchup: matchup, gamePk: game.gamePk },
        odds: odds ? [odds] : [],
        best_odds: bestOdds,
        probabilities: probs,
        combinada,
        data_quality: dq,
        cache_version: BASEBALL_CACHE_VERSION,
        updated_at: new Date().toISOString(),
      });
      if (upsertErr) {
        console.error(`[baseball-analyze] PERSIST FALLÓ fid=${fixtureId}:`, upsertErr.message || upsertErr);
        return { kind: 'persist_failed', fixtureId, error: upsertErr.message || String(upsertErr) };
      }

      const { error: predErr } = await supabaseAdmin.from('baseball_match_predictions').upsert({
        fixture_id: fixtureId,
        date,
        league_id: game.sportId === 1 ? 1 : game.sportId,
        home_team_id: game.home?.id,
        away_team_id: game.away?.id,
        ...flattenProbabilitiesForStorage(probs),
        updated_at: new Date().toISOString(),
      });
      if (predErr) console.warn(`[baseball-analyze] predictions fail (no critico) ${fixtureId}: ${predErr.message}`);

      const pf = matchup ? `H:${matchup.home?.factor} A:${matchup.away?.factor}` : 'sin pitchers';
      console.log(`[baseball-analyze] ✓ ${fixtureId} ${awayName} @ ${homeName} | ML ${probs.moneyline?.home}/${probs.moneyline?.away} | ${pf} | dq=${dq?.score}`);
      return { kind: 'analyzed', fixtureId };
    } catch (e) {
      const msg = e?.message || String(e);
      logger.error({ job: 'baseball-analyze', fixtureId, err: msg, stack: e?.stack?.split('\n').slice(0, 4).join('\n') }, `game ${fixtureId} failed: ${msg}`);
      return { kind: 'failed', fixtureId, error: msg };
    }
  }

  await mapPool(games, BASEBALL_ANALYZE_CONCURRENCY, async (game) => {
    const r = await processOne(game);
    if (r.kind === 'analyzed') analyzed++;
    else if (r.kind === 'skipped') skipped++;
    else if (r.kind === 'persist_failed') { persistFailed++; errors.push({ fixtureId: r.fixtureId, error: r.error }); }
    else if (r.kind === 'failed') { failed++; errors.push({ fixtureId: r.fixtureId, error: r.error }); }
    processed++;
    await reportProgress({ phase: 'analyzing', processed, total: games.length, analyzed, skipped, failed: failed + persistFailed, startedAt, firstError: errors[0]?.error || null });
    await new Promise(res => setImmediate(res));
    return r;
  });

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const totalFails = failed + persistFailed;
  await reportProgress({ phase: totalFails > 0 ? 'failed' : 'complete', processed: games.length, total: games.length, analyzed, skipped, failed: totalFails, startedAt, durationSec: Number(durationSec) });

  logger.info({ summary: 'baseball-analyze', date, total: games.length, analyzed, skipped, failed, persistFailed, durationSec: Number(durationSec), firstErrors: errors.slice(0, 5) },
    `baseball-analyze (MLB) done — ${analyzed} ok, ${skipped} skipped, ${failed} failed, ${persistFailed} persist-failed in ${durationSec}s`);

  if (totalFails > 0) {
    throw new Error(`baseball-analyze incomplete: ${failed} análisis + ${persistFailed} persist failures of ${games.length}`);
  }
  return { ok: true, date, total: games.length, analyzed, skipped, failed, persistFailed, durationSec: Number(durationSec), errors: errors.slice(0, 5) };
}
