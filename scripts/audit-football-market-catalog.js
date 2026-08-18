/* eslint-disable no-console */
// Auditoría reproducible y de solo lectura del catálogo de mercados servido.
// Recalcula todos los mercados (también los <70%), adjunta la fiabilidad y
// compara cada definición con todos los resultados finalizados almacenados.
//
// Uso:
//   node scripts/audit-football-market-catalog.js --date 2026-08-18 --out qa-results/football-market-audit-2026-08-18

// Genera:
//   all-markets.csv  — todos los partidos y mercados del día
//   summary.json     — invariantes, funnel y cobertura histórica

// No escribe en PostgreSQL ni modifica los análisis cacheados.

try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { predict } = require('../lib/model-engine.js');
const { modelToScored, playerMarketsToSelections } = require('../lib/model-to-scored.js');
const { buildPlayerMarkets } = require('../lib/model-player-markets.js');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const date = arg('date', new Date().toISOString().slice(0, 10));
const outDir = path.resolve(arg('out', `qa-results/football-market-audit-${date}`));
const focusFixture = Number(arg('fixture', 0)) || null;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3,
});

const pct = value => value == null || !Number.isFinite(Number(value))
  ? null
  : Number((Number(value) * 100).toFixed(4));

function unwrapAnalysis(value) {
  if (!value || typeof value !== 'object') return {};
  return value.analysis && typeof value.analysis === 'object' ? value.analysis : value;
}

function csvCell(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map(column => csvCell(row[column])).join(','));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

function completedValue(row, side, family, half) {
  if (family === 'goals') {
    if (half === '1h') {
      if (side === 'home') return row.gf_1h;
      if (side === 'away') return row.ga_1h;
      return row.gf_1h == null || row.ga_1h == null ? null : Number(row.gf_1h) + Number(row.ga_1h);
    }
    if (half === '2h') {
      if (side === 'home') return row.gf_2h;
      if (side === 'away') return row.ga_2h;
      return row.gf_2h == null || row.ga_2h == null ? null : Number(row.gf_2h) + Number(row.ga_2h);
    }
    return side === 'total' ? row.ft_home + row.ft_away : side === 'home' ? row.ft_home : row.ft_away;
  }
  const map = {
    corners: ['corners_for', 'corners_against'],
    shots: ['shots_for', 'shots_against'],
    sot: ['sot_for', 'sot_against'],
    fouls: ['fouls_for', 'fouls_against'],
    offsides: ['offsides_for', 'offsides_against'],
  };
  if (family === 'cards') {
    const home = row.yellow_for == null ? null : Number(row.yellow_for) + Number(row.red_for || 0);
    const away = row.yellow_against == null ? null : Number(row.yellow_against) + Number(row.red_against || 0);
    if (side === 'home') return home;
    if (side === 'away') return away;
    return home == null || away == null ? null : home + away;
  }
  const fields = map[family];
  if (!fields) return null;
  const home = row[fields[0]], away = row[fields[1]];
  if (side === 'home') return home == null ? null : Number(home);
  if (side === 'away') return away == null ? null : Number(away);
  return home == null || away == null ? null : Number(home) + Number(away);
}

function outcomeFor(key, row) {
  const ou = key.match(/^(total|home|away)_(goals|corners|cards|shots|sot|fouls|offsides)(?:_(1h|2h))?_(over|under)(\d+)_5$/);
  if (ou) {
    const value = completedValue(row, ou[1], ou[2], ou[3] || null);
    if (value == null) return null;
    const line = Number(`${ou[5]}.5`);
    return ou[4] === 'over' ? value > line : value < line;
  }
  const diff = Number(row.ft_home) - Number(row.ft_away);
  const total = Number(row.ft_home) + Number(row.ft_away);
  const scalar = {
    home_win: diff > 0, draw: diff === 0, away_win: diff < 0,
    dc_1x: diff >= 0, dc_12: diff !== 0, dc_x2: diff <= 0,
    btts: row.ft_home > 0 && row.ft_away > 0,
    btts_no: row.ft_home === 0 || row.ft_away === 0,
    clean_sheet_home: row.ft_away === 0,
    clean_sheet_away: row.ft_home === 0,
    goals_odd: total % 2 === 1,
    goals_even: total % 2 === 0,
    red_card_any: Number(row.red_for || 0) + Number(row.red_against || 0) > 0,
    red_card_home: Number(row.red_for || 0) > 0,
    red_card_away: Number(row.red_against || 0) > 0,
    ah_home_m0_5: diff > 0,
    ah_home_m1_5: diff >= 2,
    ah_home_p0_5: diff >= 0,
    ah_home_p1_5: diff >= -1,
    eh_home_m1: diff >= 2,
    eh_home_p1: diff >= 0,
  };
  if (Object.prototype.hasOwnProperty.call(scalar, key)) return scalar[key];
  if (key === 'first_goal_45') {
    if (row.first_goal_minute != null) return Number(row.first_goal_minute) <= 45;
    return total === 0 ? false : null;
  }
  const score = key.match(/^cs_(\d+)_(\d+)$/);
  if (score) return Number(row.ft_home) === Number(score[1]) && Number(row.ft_away) === Number(score[2]);
  const exact = key.match(/^exact_goals_(\d+|7plus)$/);
  if (exact) return exact[1] === '7plus' ? total >= 7 : total === Number(exact[1]);
  return null;
}

function globalHistory(key, completed, cache) {
  if (cache.has(key)) return cache.get(key);
  let n = 0;
  let hits = 0;
  for (const row of completed) {
    const outcome = outcomeFor(key, row);
    if (outcome == null) continue;
    n += 1;
    if (outcome) hits += 1;
  }
  const result = n ? { n, hits, rate: Number(((hits / n) * 100).toFixed(4)) } : { n: 0, hits: null, rate: null };
  cache.set(key, result);
  return result;
}

function omissionReason({ probability, reliability, shown, quoteStatus }) {
  if (shown) return '';
  if (probability == null) return 'sin probabilidad';
  if (probability < 70) return 'probabilidad < 70%';
  if (reliability == null || reliability < 90) return 'fiabilidad < 90%';
  if (quoteStatus === 'below_minimum') return 'cuota real < 1.20';
  if (quoteStatus === 'unsupported_market') return 'mercado sin adaptador de cuota';
  if (quoteStatus === 'line_not_offered') return 'línea exacta no entregada por bet365/bwin';
  return 'cuota no utilizable';
}

function playerStartXi(lineups) {
  if (!lineups?.available || !Array.isArray(lineups.data)) return [];
  const result = [];
  for (const team of lineups.data) {
    for (const item of (team?.startXI || [])) {
      if (!item?.player?.id) continue;
      result.push({
        player_id: Number(item.player.id),
        team_id: team.team?.id == null ? null : Number(team.team.id),
        name: item.player.name || null,
        position: item.player.pos || null,
      });
    }
  }
  return result;
}

(async () => {
  const [modelProbabilities, labels] = await Promise.all([
    import('../lib/model-probabilities.js'),
    import('../lib/market-labels.js'),
  ]);
  const { buildModelCtx, buildModelDescriptives, buildCalculatedProbabilities, buildModelCombinada, inspectMarketOdd } = modelProbabilities;
  const { marketLabel } = labels;

  const { rows: analyses } = await pool.query(
    `SELECT ma.fixture_id,ma.analysis,ma.combinada,ma.cache_version,
            mm.season,mm.kickoff model_kickoff,mm.round model_round,
            mm.referee model_referee
     FROM match_analysis ma
     LEFT JOIN model.matches mm ON mm.fixture_id=ma.fixture_id
     WHERE ma.date=$1
     ORDER BY mm.kickoff NULLS LAST,ma.fixture_id`,
    [date],
  );
  const { rows: completed } = await pool.query(
    `SELECT m.fixture_id,m.ft_home,m.ft_away,t.corners_for,t.corners_against,
            t.shots_for,t.shots_against,t.sot_for,t.sot_against,
            t.fouls_for,t.fouls_against,t.offsides_for,t.offsides_against,
            t.yellow_for,t.yellow_against,t.red_for,t.red_against,
            t.gf_1h,t.ga_1h,t.gf_2h,t.ga_2h,t.first_goal_minute
     FROM model.matches m
     JOIN model.team_match_stats t
       ON t.fixture_id=m.fixture_id AND t.team_id=m.home_team_id
     WHERE m.result IS NOT NULL AND m.ft_home IS NOT NULL AND m.ft_away IS NOT NULL`,
  );

  const rows = [];
  const fixtureSummaries = [];
  const historyCache = new Map();
  let complementViolations = 0;
  let monotonicViolations = 0;

  for (const stored of analyses) {
    const analysis = unwrapAnalysis(stored.analysis);
    const kickoff = new Date(analysis.kickoff || stored.model_kickoff || `${date}T23:59:59Z`);
    const ctx = await buildModelCtx(pool, {
      fixtureId: stored.fixture_id,
      leagueId: analysis.leagueId,
      season: stored.season,
      round: analysis.leagueRound || stored.model_round,
      referee: analysis.referee || stored.model_referee,
      homeId: analysis.homeId,
      awayId: analysis.awayId,
      homeRank: analysis.homePosition,
      awayRank: analysis.awayPosition,
      cutoff: kickoff,
    });
    const lineups = analysis.lineups?.available ? analysis.lineups.data : null;
    const prediction = await predict(pool, ctx, { currentLineups: lineups });
    const scored = modelToScored(prediction.markets, { validationFamilies: prediction.validationFamilies });
    const descriptives = await buildModelDescriptives(pool, ctx);
    const probabilities = buildCalculatedProbabilities(scored, descriptives, analysis);
    const startXi = playerStartXi(analysis.lineups);
    const playerMarkets = startXi.length
      ? await buildPlayerMarkets(pool, startXi, {
        cutoff: kickoff,
        season: ctx.season,
        currentShare: prediction.fixture?.engineConfig?.currentShare,
      })
      : {};
    const teamNames = { home: analysis.homeTeam, away: analysis.awayTeam };
    const combinada = buildModelCombinada(
      scored,
      analysis.odds,
      teamNames,
      playerMarkets,
      probabilities,
      analysis.cornerCardData,
    );
    const shown = new Map((combinada.selectable || []).map(selection => [String(selection.id), selection]));

    const fixtureRows = [];
    for (const [key, entry] of Object.entries(scored)) {
      const probability = pct(entry.prob_final);
      const reliability = pct(entry.confidence);
      const selection = shown.get(key);
      const quote = inspectMarketOdd(key, analysis.odds);
      const history = globalHistory(key, completed, historyCache);
      const validation = entry.validation || {};
      fixtureRows.push({
        date,
        fixture_id: Number(stored.fixture_id),
        match: `${analysis.homeTeam || '?'} vs ${analysis.awayTeam || '?'}`,
        league: analysis.league || '',
        kickoff: analysis.kickoff || kickoff.toISOString(),
        market_key: key,
        market: marketLabel(key, teamNames),
        scope: 'team',
        probability_pct: probability,
        reliability_pct: reliability,
        context_sample_n: Number(entry.n || 0),
        context_hits: entry.hits,
        context_raw_hit_rate_pct: entry.hits == null || !entry.n ? null : Number(((Number(entry.hits) / Number(entry.n)) * 100).toFixed(4)),
        validation_band: validation.band || '',
        validation_sample_n: Number(validation.n || 0),
        validation_predicted_pct: pct(validation.avgPred),
        validation_actual_pct: pct(validation.avgActual),
        validation_gap_pp: validation.gap == null ? null : Number((Number(validation.gap) * 100).toFixed(4)),
        all_results_sample_n: history.n,
        all_results_hits: history.hits,
        all_results_actual_pct: history.rate,
        platform_shown: Boolean(selection),
        exact_odd: quote.odd,
        bookmaker: quote.bookmaker || '',
        quote_status: quote.status,
        quote_field: quote.field || '',
        quote_line_candidates: quote.candidates.join('|'),
        recommended_80: Boolean(entry.recommended),
        omission_reason: omissionReason({ probability, reliability, shown: Boolean(selection), quoteStatus: quote.status }),
      });
    }

    for (const selection of playerMarketsToSelections(playerMarkets)) {
      const probability = Number(selection.rawProbability ?? selection.probability);
      const reliability = Number(selection.confidence);
      const current = shown.get(String(selection.id));
      fixtureRows.push({
        date,
        fixture_id: Number(stored.fixture_id),
        match: `${analysis.homeTeam || '?'} vs ${analysis.awayTeam || '?'}`,
        league: analysis.league || '',
        kickoff: analysis.kickoff || kickoff.toISOString(),
        market_key: selection.id,
        market: selection.name,
        scope: 'player',
        probability_pct: Number(probability.toFixed(4)),
        reliability_pct: Number.isFinite(reliability) ? Number(reliability.toFixed(4)) : null,
        context_sample_n: Number(selection.sampleN || 0),
        context_hits: null,
        context_raw_hit_rate_pct: null,
        validation_band: '',
        validation_sample_n: 0,
        validation_predicted_pct: null,
        validation_actual_pct: null,
        validation_gap_pp: null,
        all_results_sample_n: Number(selection.sampleN || 0),
        all_results_hits: null,
        all_results_actual_pct: null,
        platform_shown: Boolean(current),
        exact_odd: current?.odd ?? null,
        bookmaker: current?.bookmaker ?? '',
        quote_status: current ? 'offered' : 'player_quote_not_resolved',
        quote_field: '',
        quote_line_candidates: '',
        recommended_80: probability >= 80,
        omission_reason: omissionReason({ probability, reliability, shown: Boolean(current), quoteStatus: 'player_quote_not_resolved' }),
      });
    }

    // Invariantes de las escaleras O/U expuestas por la aplicación.
    const ladders = new Map();
    for (const row of fixtureRows) {
      const match = row.market_key.match(/^(.+)_(over|under)(\d+)_5$/);
      if (!match) continue;
      const ladderKey = `${match[1]}:${match[2]}`;
      if (!ladders.has(ladderKey)) ladders.set(ladderKey, []);
      ladders.get(ladderKey).push({ line: Number(match[3]), probability: Number(row.probability_pct) });
      const opposite = fixtureRows.find(candidate => candidate.market_key === `${match[1]}_${match[2] === 'over' ? 'under' : 'over'}${match[3]}_5`);
      if (opposite && match[2] === 'over' && Math.abs(row.probability_pct + opposite.probability_pct - 100) > 0.001) complementViolations += 1;
    }
    for (const [ladderKey, ladder] of ladders) {
      ladder.sort((a, b) => a.line - b.line);
      const over = ladderKey.endsWith(':over');
      for (let index = 1; index < ladder.length; index += 1) {
        if (over && ladder[index].probability > ladder[index - 1].probability + 0.001) monotonicViolations += 1;
        if (!over && ladder[index].probability < ladder[index - 1].probability - 0.001) monotonicViolations += 1;
      }
    }

    rows.push(...fixtureRows);
    fixtureSummaries.push({
      fixtureId: Number(stored.fixture_id),
      match: `${analysis.homeTeam || '?'} vs ${analysis.awayTeam || '?'}`,
      totalMarkets: fixtureRows.length,
      probability70: fixtureRows.filter(row => row.probability_pct >= 70).length,
      reliability90: fixtureRows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90).length,
      shown: fixtureRows.filter(row => row.platform_shown).length,
      quoted: fixtureRows.filter(row => row.exact_odd != null).length,
      quotedEligible: fixtureRows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90 && row.quote_status === 'offered').length,
      belowMinimumOdd: fixtureRows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90 && row.quote_status === 'below_minimum').length,
      lineNotOffered: fixtureRows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90 && row.quote_status === 'line_not_offered').length,
      unsupportedMarket: fixtureRows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90 && row.quote_status === 'unsupported_market').length,
      playerMarkets: fixtureRows.filter(row => row.scope === 'player').length,
    });
    console.log(`[market-audit] ${stored.fixture_id} ${analysis.homeTeam} vs ${analysis.awayTeam}: ${fixtureRows.length} mercados, ${combinada.selectable?.length || 0} visibles`);
  }

  const columns = [
    'date', 'fixture_id', 'match', 'league', 'kickoff', 'market_key', 'market', 'scope',
    'probability_pct', 'reliability_pct', 'context_sample_n', 'context_hits', 'context_raw_hit_rate_pct',
    'validation_band', 'validation_sample_n', 'validation_predicted_pct', 'validation_actual_pct', 'validation_gap_pp',
    'all_results_sample_n', 'all_results_hits', 'all_results_actual_pct',
    'platform_shown', 'exact_odd', 'bookmaker', 'quote_status', 'quote_field', 'quote_line_candidates',
    'recommended_80', 'omission_reason',
  ];
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeCsv(path.join(outDir, 'all-markets.csv'), rows, columns);
  if (focusFixture) {
    writeCsv(
      path.join(outDir, `fixture-${focusFixture}-markets.csv`),
      rows.filter(row => row.fixture_id === focusFixture),
      columns,
    );
  }

  const shownRows = rows.filter(row => row.platform_shown);
  const validationWarnings = rows
    .filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90
      && row.validation_sample_n >= 30 && row.validation_actual_pct != null
      && row.validation_actual_pct < 70)
    .map(row => ({
      fixtureId: row.fixture_id,
      match: row.match,
      marketKey: row.market_key,
      probability: row.probability_pct,
      reliability: row.reliability_pct,
      validationN: row.validation_sample_n,
      validationActual: row.validation_actual_pct,
    }));
  const summary = {
    date,
    focusFixture,
    generatedAt: new Date().toISOString(),
    analyzedFixtures: analyses.length,
    completedResultsCompared: completed.length,
    totalMarketRows: rows.length,
    teamMarketRows: rows.filter(row => row.scope === 'team').length,
    playerMarketRows: rows.filter(row => row.scope === 'player').length,
    probability70Rows: rows.filter(row => row.probability_pct >= 70).length,
    probability70Reliability90Rows: rows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90).length,
    platformShownRows: shownRows.length,
    quotedRows: rows.filter(row => row.exact_odd != null).length,
    eligibleOfferedRows: rows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90 && row.quote_status === 'offered').length,
    eligibleBelowMinimumRows: rows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90 && row.quote_status === 'below_minimum').length,
    eligibleLineNotOfferedRows: rows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90 && row.quote_status === 'line_not_offered').length,
    eligibleUnsupportedMarketRows: rows.filter(row => row.probability_pct >= 70 && row.reliability_pct >= 90 && row.quote_status === 'unsupported_market').length,
    shownOverRows: shownRows.filter(row => /_over\d+_5$/.test(row.market_key)).length,
    shownUnderRows: shownRows.filter(row => /_under\d+_5$/.test(row.market_key)).length,
    shownOtherRows: shownRows.filter(row => !/_(?:over|under)\d+_5$/.test(row.market_key)).length,
    shownOddMin: shownRows.length ? Math.min(...shownRows.map(row => Number(row.exact_odd))) : null,
    shownOddMax: shownRows.length ? Math.max(...shownRows.map(row => Number(row.exact_odd))) : null,
    complementViolations,
    monotonicViolations,
    validationWarningsCount: validationWarnings.length,
    shownValidationWarnings: validationWarnings.filter(warning => rows.some(row =>
      row.fixture_id === warning.fixtureId
      && row.market_key === warning.marketKey
      && row.platform_shown)),
    validationWarnings,
    fixtureSummaries,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outDir, ...summary, fixtureSummaries: undefined }, null, 2));
  await pool.end();
})().catch(async (error) => {
  console.error(error?.stack || error);
  await pool.end().catch(() => {});
  process.exit(1);
});
