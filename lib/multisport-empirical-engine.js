// Motor empírico común de implementación y AISLADO por almacenamiento/modelo.
//
// La fórmula contractual es la misma que fútbol:
//   probabilidad = frecuencia observada ponderada por actualidad y semejanza.
//
// No usa Poisson, isotónica, cuotas, priors de liga, shrinkage ni mínimos de
// muestra. Una observación real cuenta; cero observaciones devuelve null. Las
// cuotas se adjuntan después y nunca entran en el porcentaje.

import { getMultisportConfig } from './multisport-config.js';

export const DEFAULT_MULTISPORT_ENGINE_CONFIG = Object.freeze({
  currentShare: 0.72,
  venueBoost: 1.18,
  opponentBoost: 1.22,
  competitionBoost: 1.06,
  starterBoost: 1.18,
  lineupBoost: 1.12,
});

const CONFIG_MARKET = '__empirical_engine__';
const CONFIG_TTL_MS = 10 * 60 * 1000;
const configCache = new Map();

function compactValidation(metrics) {
  if (!metrics) return null;
  return {
    validation: metrics.validation || {},
    processed: Number(metrics.processed || 0),
    holdout: Number(metrics.holdout || 0),
    version: Number(metrics.version || 0),
  };
}

const numberOrNull = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const bounded = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export function normalizeMultisportEngineConfig(raw = {}) {
  return {
    currentShare: bounded(raw.currentShare, DEFAULT_MULTISPORT_ENGINE_CONFIG.currentShare, 0.51, 0.95),
    venueBoost: bounded(raw.venueBoost, DEFAULT_MULTISPORT_ENGINE_CONFIG.venueBoost, 1, 2),
    opponentBoost: bounded(raw.opponentBoost, DEFAULT_MULTISPORT_ENGINE_CONFIG.opponentBoost, 1, 2),
    competitionBoost: bounded(raw.competitionBoost, DEFAULT_MULTISPORT_ENGINE_CONFIG.competitionBoost, 1, 2),
    starterBoost: bounded(raw.starterBoost, DEFAULT_MULTISPORT_ENGINE_CONFIG.starterBoost, 1, 2.5),
    lineupBoost: bounded(raw.lineupBoost, DEFAULT_MULTISPORT_ENGINE_CONFIG.lineupBoost, 1, 2.5),
  };
}

async function loadConfig(pool, sport) {
  const cached = configCache.get(sport);
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.value;
  let value = { ...DEFAULT_MULTISPORT_ENGINE_CONFIG, version: 0, validation: null };
  try {
    const { rows } = await pool.query(
      `SELECT weights, version, metrics FROM prediction_models
       WHERE sport=$1 AND market_key=$2 AND model_type='empirical-weighting' AND active=TRUE
       ORDER BY version DESC LIMIT 1`,
      [sport, CONFIG_MARKET],
    );
    if (rows[0]) value = {
      ...normalizeMultisportEngineConfig(rows[0].weights || {}),
      version: Number(rows[0].version) || 0,
      validation: compactValidation(rows[0].metrics),
    };
  } catch {
    // La ausencia de una configuración entrenada no impide contar los hechos.
  }
  configCache.set(sport, { at: Date.now(), value });
  return value;
}

export function resetMultisportEngineConfigCache(sport = null) {
  if (sport) configCache.delete(sport);
  else configCache.clear();
}

function jaccard(left, right) {
  const a = new Set((left || []).map(String));
  const b = new Set((right || []).map(String));
  if (!a.size || !b.size) return null;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function contextualize(rows, fixture, side, config) {
  const isHome = side === 'home';
  const opponentId = String(fixture.teams?.[isHome ? 'away' : 'home']?.id || '');
  const currentStarters = fixture.context?.[side]?.starters || [];
  const currentStarter = fixture.context?.[side]?.starterId;
  const currentOpponentStarter = fixture.context?.[isHome ? 'away' : 'home']?.starterId;
  return rows.map((row) => {
    const stats = row.stats || {};
    let weight = 1;
    if (row.is_home === isHome) weight *= config.venueBoost;
    if (opponentId && String(row.opponent_id) === opponentId) weight *= config.opponentBoost;
    if (fixture.league?.id != null && String(row.competition_id) === String(fixture.league.id)) weight *= config.competitionBoost;
    const ownStarter = stats.starterId ?? stats.startingPitcherId ?? stats.quarterbackId;
    const opponentStarter = stats.opponentStarterId ?? stats.opponentStartingPitcherId ?? stats.opponentQuarterbackId;
    if (currentStarter != null && String(ownStarter || '') === String(currentStarter)) weight *= config.starterBoost;
    if (currentOpponentStarter != null && String(opponentStarter || '') === String(currentOpponentStarter)) weight *= config.starterBoost;
    const similarity = jaccard(currentStarters, stats.starters || []);
    if (similarity != null) weight *= 1 + (config.lineupBoost - 1) * similarity;
    return {
      ...row,
      _weight: weight,
      _current: fixture.season != null && String(row.season) === String(fixture.season),
      _side: side,
    };
  });
}

function dedupeObservations(groups) {
  const byFixture = new Map();
  for (const observation of groups.flat()) {
    if (observation._value == null || !Number.isFinite(Number(observation._value))) continue;
    const key = String(observation.fixture_id);
    const previous = byFixture.get(key);
    // En un H2H ambas perspectivas describen el mismo hecho. Se conserva una
    // sola, con el mayor peso de semejanza, para no duplicar la muestra.
    if (!previous || observation._weight > previous._weight) byFixture.set(key, observation);
  }
  return [...byFixture.values()];
}

function project(primaryRows, primaryValue, opponentRows, opponentValue) {
  return dedupeObservations([
    primaryRows.map((row) => ({ ...row, _value: primaryValue(row) })),
    opponentRows.map((row) => ({ ...row, _value: opponentValue(row) })),
  ]);
}

function segmentRate(rows, predicate) {
  let weightedHits = 0;
  let weight = 0;
  let hits = 0;
  let n = 0;
  for (const row of rows) {
    const result = predicate(Number(row._value), row);
    if (result == null) continue;
    const w = Number(row._weight) > 0 ? Number(row._weight) : 1;
    weightedHits += w * Number(result);
    weight += w;
    hits += Number(result);
    n++;
  }
  return { p: n ? weightedHits / weight : null, n, hits, weightedHits, weight };
}

function empiricalRate(rows, predicate, currentShare) {
  const current = segmentRate(rows.filter((row) => row._current), predicate);
  const historical = segmentRate(rows.filter((row) => !row._current), predicate);
  let p = null;
  if (current.n && historical.n) p = currentShare * current.p + (1 - currentShare) * historical.p;
  else if (current.n) p = current.p;
  else if (historical.n) p = historical.p;
  return {
    p,
    n: current.n + historical.n,
    hits: current.hits + historical.hits,
    current,
    historical,
  };
}

function segmentMean(rows) {
  let total = 0;
  let weight = 0;
  let n = 0;
  for (const row of rows) {
    const value = Number(row._value);
    if (!Number.isFinite(value)) continue;
    const w = Number(row._weight) > 0 ? Number(row._weight) : 1;
    total += value * w;
    weight += w;
    n++;
  }
  return { mean: n ? total / weight : null, n, weight };
}

function empiricalMean(rows, currentShare) {
  const current = segmentMean(rows.filter((row) => row._current));
  const historical = segmentMean(rows.filter((row) => !row._current));
  if (current.n && historical.n) return currentShare * current.mean + (1 - currentShare) * historical.mean;
  if (current.n) return current.mean;
  return historical.mean;
}

function displayPercent(p) {
  if (p == null || !Number.isFinite(p)) return null;
  // `rawProbability` conserva la frecuencia real 0–1 para todas las decisiones.
  // Este valor es exclusivamente de presentación: máximo 95% y truncado por
  // debajo para no convertir 94.999% en 95% por redondeo.
  const boundedProbability = Math.max(0, Math.min(1, p));
  const percent = boundedProbability * 100;
  if (percent >= 95) return 95;
  return Math.floor((percent + 1e-9) * 100) / 100;
}

function audit(rate, currentShare) {
  return {
    rawProbability: rate.p,
    n: rate.n,
    hits: rate.hits,
    currentShare: rate.current.n && rate.historical.n ? currentShare : (rate.current.n ? 1 : 0),
    current: { p: rate.current.p, n: rate.current.n, hits: rate.current.hits, weight: rate.current.weight },
    historical: { p: rate.historical.p, n: rate.historical.n, hits: rate.historical.hits, weight: rate.historical.weight },
  };
}

function probability(rows, predicate, currentShare) {
  const rate = empiricalRate(rows, predicate, currentShare);
  return { probability: displayPercent(rate.p), rawProbability: rate.p, evidence: audit(rate, currentShare) };
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function linesFor(rows, offered = [], required = []) {
  const observed = rows.map((row) => Number(row._value)).filter(Number.isFinite);
  const dynamic = [0.2, 0.35, 0.5, 0.65, 0.8]
    .map((q) => percentile(observed, q))
    .filter((value) => value != null)
    .map((value) => Math.floor(value) + 0.5);
  return [...new Set([...offered, ...required, ...dynamic]
    .map(Number).filter((value) => Number.isFinite(value) && value >= 0))]
    .sort((a, b) => a - b);
}

function ladder(rows, offered, required, currentShare) {
  const result = {};
  for (const line of linesFor(rows, offered, required)) {
    const over = probability(rows, (value) => value > line ? 1 : 0, currentShare);
    const under = probability(rows, (value) => value < line ? 1 : 0, currentShare);
    if (over.probability == null && under.probability == null) continue;
    result[line] = { over, under };
  }
  return result;
}

function valueFromStats(row, key) {
  const stats = row.stats || {};
  const direct = numberOrNull(stats[key]);
  if (direct != null) return direct;
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [candidate, value] of Object.entries(stats)) {
    if (String(candidate).toLowerCase().replace(/[^a-z0-9]/g, '') === normalized) return numberOrNull(value);
  }
  return null;
}

function periodTotal(row, count) {
  const periods = Array.isArray(row.period_scores) ? row.period_scores : (row.period_scores?.for || []);
  if (!Array.isArray(periods) || periods.length < count) return null;
  const values = periods.slice(0, count).map(numberOrNull);
  if (values.some((value) => value == null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function standardLines(sport, kind) {
  if (sport !== 'baseball') return [];
  if (kind === 'totals') return [7.5, 8.5, 9.5, 10.5];
  if (kind === 'team') return [3.5, 4.5];
  if (kind === 'period') return [4.5, 5.5];
  return [];
}

function statFamilies(sport) {
  if (sport === 'baseball') return [
    ['hits', 'hits'], ['errors', 'errors'],
  ];
  if (sport === 'basketball') return [
    ['rebounds', 'rebotes'], ['assists', 'asistencias'], ['threePointersMade', 'triples'],
    ['steals', 'robos'], ['blocks', 'tapones'], ['turnovers', 'pérdidas'], ['personalFouls', 'faltas'],
  ];
  return [
    ['totalYards', 'yardas'], ['passingYards', 'yardas de pase'], ['rushingYards', 'yardas terrestres'],
    ['turnovers', 'pérdidas'], ['firstDowns', 'primeros downs'], ['sacks', 'capturas'],
    ['penalties', 'penalizaciones'], ['interceptions', 'intercepciones'],
  ];
}

function publicProbability(entry) {
  if (!entry) return null;
  return { probability: entry.probability, rawProbability: entry.rawProbability, evidence: entry.evidence };
}

export async function computeMultisportEmpiricalPrediction(pool, input) {
  const config = getMultisportConfig(input.sport);
  const fixture = input.fixture;
  const cutoff = input.cutoff || fixture.date || new Date();
  const table = `${config.tablePrefix}_engine_team_stats`;
  const suppliedRows = input.teamRows || null;
  const [homeResult, awayResult, loadedConfig] = await Promise.all([
    suppliedRows
      ? Promise.resolve({ rows: (suppliedRows.home || []).filter((row) => new Date(row.kickoff) < new Date(cutoff)) })
      : pool.query(`SELECT * FROM ${table} WHERE team_id=$1 AND kickoff < $2 ORDER BY kickoff DESC`, [String(fixture.teams.home.id), cutoff]),
    suppliedRows
      ? Promise.resolve({ rows: (suppliedRows.away || []).filter((row) => new Date(row.kickoff) < new Date(cutoff)) })
      : pool.query(`SELECT * FROM ${table} WHERE team_id=$1 AND kickoff < $2 ORDER BY kickoff DESC`, [String(fixture.teams.away.id), cutoff]),
    input.config ? Promise.resolve({ ...normalizeMultisportEngineConfig(input.config), version: input.config.version || 0, validation: input.config.validation || null }) : loadConfig(pool, config.key),
  ]);
  const engineConfig = normalizeMultisportEngineConfig(loadedConfig);
  const homeRows = contextualize(homeResult.rows, fixture, 'home', engineConfig);
  const awayRows = contextualize(awayResult.rows, fixture, 'away', engineConfig);
  const share = engineConfig.currentShare;

  const homeScore = project(homeRows, (row) => numberOrNull(row.score_for), awayRows, (row) => numberOrNull(row.score_against));
  const awayScore = project(awayRows, (row) => numberOrNull(row.score_for), homeRows, (row) => numberOrNull(row.score_against));
  const totalScore = dedupeObservations([
    homeRows.map((row) => ({ ...row, _value: numberOrNull(row.score_for) == null || numberOrNull(row.score_against) == null ? null : Number(row.score_for) + Number(row.score_against) })),
    awayRows.map((row) => ({ ...row, _value: numberOrNull(row.score_for) == null || numberOrNull(row.score_against) == null ? null : Number(row.score_for) + Number(row.score_against) })),
  ]);
  const homeMargin = project(homeRows,
    (row) => numberOrNull(row.score_for) == null || numberOrNull(row.score_against) == null ? null : Number(row.score_for) - Number(row.score_against),
    awayRows,
    (row) => numberOrNull(row.score_for) == null || numberOrNull(row.score_against) == null ? null : Number(row.score_against) - Number(row.score_for));

  const homeWin = probability(homeMargin, (value) => value > 0 ? 1 : 0, share);
  const awayWin = probability(homeMargin, (value) => value < 0 ? 1 : 0, share);
  const draw = config.drawAllowed ? probability(homeMargin, (value) => value === 0 ? 1 : 0, share) : null;
  const offeredTotals = Object.keys(input.odds?.totals || {}).map(Number);
  const totals = ladder(totalScore, offeredTotals, standardLines(config.key, 'totals'), share);
  const homeTotals = ladder(homeScore, [], standardLines(config.key, 'team'), share);
  const awayTotals = ladder(awayScore, [], standardLines(config.key, 'team'), share);

  const periodCount = config.periodKind === 'first5' ? 5 : 2;
  // Para el total de periodo cada fila histórica debe sumar a ambos equipos.
  const historicalPeriodTotals = dedupeObservations([
    homeRows.map((row) => {
      const own = periodTotal(row, periodCount);
      const against = Array.isArray(row.period_scores_against) ? row.period_scores_against : row.period_scores?.against;
      const other = Array.isArray(against) && against.length >= periodCount
        ? against.slice(0, periodCount).map(numberOrNull) : [];
      return { ...row, _value: own == null || other.length !== periodCount || other.some((v) => v == null) ? null : own + other.reduce((sum, v) => sum + v, 0) };
    }),
    awayRows.map((row) => {
      const own = periodTotal(row, periodCount);
      const against = Array.isArray(row.period_scores_against) ? row.period_scores_against : row.period_scores?.against;
      const other = Array.isArray(against) && against.length >= periodCount
        ? against.slice(0, periodCount).map(numberOrNull) : [];
      return { ...row, _value: own == null || other.length !== periodCount || other.some((v) => v == null) ? null : own + other.reduce((sum, v) => sum + v, 0) };
    }),
  ]);
  const periodMargin = project(homeRows,
    (row) => {
      const own = periodTotal(row, periodCount);
      const against = Array.isArray(row.period_scores_against) ? row.period_scores_against : row.period_scores?.against;
      const vals = Array.isArray(against) ? against.slice(0, periodCount).map(numberOrNull) : [];
      return own == null || vals.length !== periodCount || vals.some((v) => v == null) ? null : own - vals.reduce((s, v) => s + v, 0);
    },
    awayRows,
    (row) => {
      const own = periodTotal(row, periodCount);
      const against = Array.isArray(row.period_scores_against) ? row.period_scores_against : row.period_scores?.against;
      const vals = Array.isArray(against) ? against.slice(0, periodCount).map(numberOrNull) : [];
      return own == null || vals.length !== periodCount || vals.some((v) => v == null) ? null : vals.reduce((s, v) => s + v, 0) - own;
    });

  const statMarkets = {};
  for (const [key, label] of statFamilies(config.key)) {
    const home = project(homeRows, (row) => valueFromStats(row, key), awayRows, (row) => valueFromStats(row, `opponent${key[0].toUpperCase()}${key.slice(1)}`));
    const away = project(awayRows, (row) => valueFromStats(row, key), homeRows, (row) => valueFromStats(row, `opponent${key[0].toUpperCase()}${key.slice(1)}`));
    const total = dedupeObservations([
      homeRows.map((row) => {
        const a = valueFromStats(row, key), b = valueFromStats(row, `opponent${key[0].toUpperCase()}${key.slice(1)}`);
        return { ...row, _value: a == null || b == null ? null : a + b };
      }),
      awayRows.map((row) => {
        const a = valueFromStats(row, key), b = valueFromStats(row, `opponent${key[0].toUpperCase()}${key.slice(1)}`);
        return { ...row, _value: a == null || b == null ? null : a + b };
      }),
    ]);
    if (home.length || away.length || total.length) {
      statMarkets[key] = { label, home: ladder(home, [], [], share), away: ladder(away, [], [], share), total: ladder(total, [], [], share) };
    }
  }

  const spread = 1.5;
  const output = {
    sport: config.key,
    engine: {
      type: 'empirical-weighting', version: loadedConfig.version || 0,
      config: engineConfig, validation: loadedConfig.validation || null,
      samples: { homeTeam: homeRows.length, awayTeam: awayRows.length },
    },
    moneyline: { home: publicProbability(homeWin), away: publicProbability(awayWin), ...(draw ? { draw: publicProbability(draw) } : {}) },
    totals: { lines: totals },
    teamTotals: { home: homeTotals, away: awayTotals },
    spread: {
      homeMinus: { line: -spread, ...probability(homeMargin, (value) => value > spread ? 1 : 0, share) },
      homePlus: { line: spread, ...probability(homeMargin, (value) => value > -spread ? 1 : 0, share) },
      awayMinus: { line: -spread, ...probability(homeMargin, (value) => value < -spread ? 1 : 0, share) },
      awayPlus: { line: spread, ...probability(homeMargin, (value) => value < spread ? 1 : 0, share) },
    },
    period: {
      kind: config.periodKind,
      moneyline: {
        home: probability(periodMargin, (value) => value > 0 ? 1 : 0, share),
        away: probability(periodMargin, (value) => value < 0 ? 1 : 0, share),
        draw: probability(periodMargin, (value) => value === 0 ? 1 : 0, share),
      },
      totals: ladder(historicalPeriodTotals, [], standardLines(config.key, 'period'), share),
    },
    bothScore: {
      yes: probability(dedupeObservations([
        homeRows.map((row) => ({ ...row, _value: numberOrNull(row.score_for) == null || numberOrNull(row.score_against) == null ? null : (Number(row.score_for) > 0 && Number(row.score_against) > 0 ? 1 : 0) })),
        awayRows.map((row) => ({ ...row, _value: numberOrNull(row.score_for) == null || numberOrNull(row.score_against) == null ? null : (Number(row.score_for) > 0 && Number(row.score_against) > 0 ? 1 : 0) })),
      ]), (value) => value, share),
    },
    statistics: statMarkets,
    expected: {
      home: empiricalMean(homeScore, share),
      away: empiricalMean(awayScore, share),
      total: empiricalMean(totalScore, share),
    },
  };
  output.bothScore.no = output.bothScore.yes.rawProbability == null
    ? { probability: null, rawProbability: null, evidence: output.bothScore.yes.evidence }
    : { probability: displayPercent(1 - output.bothScore.yes.rawProbability), rawProbability: 1 - output.bothScore.yes.rawProbability, evidence: output.bothScore.yes.evidence };
  return output;
}

function playerMetricFamilies(sport) {
  if (sport === 'baseball') return [
    ['hits', 'hits'], ['homeRuns', 'home runs'], ['totalBases', 'bases totales'], ['rbis', 'RBI'],
    ['runs', 'carreras'], ['walks', 'bases por bolas'], ['stolenBases', 'bases robadas'],
    ['strikeouts', 'ponches del pitcher'], ['battingStrikeouts', 'ponches del bateador'],
  ];
  if (sport === 'basketball') return [
    ['points', 'puntos'], ['rebounds', 'rebotes'], ['assists', 'asistencias'],
    ['threePointersMade', 'triples'], ['steals', 'robos'], ['blocks', 'tapones'],
    ['turnovers', 'pérdidas'], ['personalFouls', 'faltas'],
  ];
  return [
    ['passingYards', 'yardas de pase'], ['rushingYards', 'yardas terrestres'],
    ['receivingYards', 'yardas recibidas'], ['receptions', 'recepciones'],
    ['passingTouchdowns', 'touchdowns de pase'], ['touchdowns', 'touchdowns'],
    ['interceptionsThrown', 'intercepciones lanzadas'], ['tackles', 'tacleadas'], ['sacks', 'capturas'],
  ];
}

// Props de jugador: se ejecuta solo con roster/XI actual confirmado por el
// proveedor. Si no hay lista actual, retorna null en vez de atribuir a un
// jugador que quizá no participe.
export async function computeMultisportEmpiricalPlayerMarkets(pool, input) {
  const config = getMultisportConfig(input.sport);
  const players = (input.players || []).map((player) => ({
    ...player,
    id: String(player.id || player.playerId || ''),
    teamId: String(player.teamId || player.team?.id || ''),
  })).filter((player) => player.id && player.teamId);
  if (!players.length) return null;
  const table = `${config.tablePrefix}_engine_player_stats`;
  const cutoff = input.cutoff || input.fixture.date || new Date();
  const [historyResult, loadedConfig] = await Promise.all([
    pool.query(`SELECT * FROM ${table} WHERE player_id=ANY($1::text[]) AND kickoff<$2 ORDER BY kickoff`, [players.map((player) => player.id), cutoff]),
    input.config ? Promise.resolve({ ...normalizeMultisportEngineConfig(input.config), version: input.config.version || 0 }) : loadConfig(pool, config.key),
  ]);
  const engineConfig = normalizeMultisportEngineConfig(loadedConfig);
  const byPlayer = new Map();
  for (const row of historyResult.rows) {
    const id = String(row.player_id);
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    byPlayer.get(id).push(row);
  }
  const output = {};
  for (const [metric, label] of playerMetricFamilies(config.key)) {
    const category = [];
    for (const player of players) {
      const opponentId = String(player.teamId) === String(input.fixture.teams.home.id)
        ? String(input.fixture.teams.away.id) : String(input.fixture.teams.home.id);
      const history = (byPlayer.get(player.id) || []).map((row) => {
        let weight = 1;
        if (String(row.opponent_id) === opponentId) weight *= engineConfig.opponentBoost;
        if (String(row.competition_id) === String(input.fixture.league?.id || '')) weight *= engineConfig.competitionBoost;
        if (player.starter === true && row.is_starter === true) weight *= engineConfig.starterBoost;
        return {
          ...row,
          _value: valueFromStats(row, metric),
          _weight: weight,
          _current: String(row.season) === String(input.fixture.season),
        };
      }).filter((row) => row._value != null);
      if (!history.length) continue;
      const lineProbs = {};
      const evidence = {};
      for (const line of linesFor(history, input.lines?.[metric] || [], [])) {
        const estimated = probability(history, (value) => value > line ? 1 : 0, engineConfig.currentShare);
        lineProbs[line] = estimated.probability;
        evidence[line] = estimated.evidence;
      }
      category.push({
        id: player.id, name: player.name || player.playerName || history[history.length - 1]?.player_name,
        teamId: player.teamId, teamName: player.teamName || player.team?.name || null,
        photo: player.photo || history[history.length - 1]?.photo || null,
        starter: player.starter === true, metric, label, lineProbs, evidence,
      });
    }
    if (category.length) output[metric] = category;
  }
  return Object.keys(output).length ? output : null;
}

function bare(entry) {
  return entry?.probability ?? null;
}

function bareLadder(lines = {}) {
  return Object.fromEntries(Object.entries(lines).map(([line, values]) => [line, {
    over: bare(values.over), under: bare(values.under),
    evidence: { over: values.over?.evidence, under: values.under?.evidence },
  }]));
}

export function buildEmpiricalPlayerProbabilities(playerHighlights) {
  if (!playerHighlights) return null;
  const result = {};
  for (const [category, players] of Object.entries(playerHighlights)) {
    if (!Array.isArray(players)) continue;
    result[category] = players.map((player) => {
      const history = (player.history || []).map(Number).filter(Number.isFinite);
      if (!history.length) return null;
      const dynamic = [0.2, 0.4, 0.6, 0.8].map((q) => Math.floor(percentile(history, q)) + 0.5);
      const lineProbs = {};
      const evidence = {};
      for (const line of [...new Set(dynamic)].sort((a, b) => a - b)) {
        const hits = history.filter((value) => value > line).length;
        const raw = hits / history.length;
        lineProbs[line] = displayPercent(raw);
        evidence[line] = { n: history.length, hits, rawProbability: raw };
      }
      return {
        id: player.id, name: player.name, teamName: player.teamName,
        photo: player.photo || (player.id ? `https://img.mlbstatic.com/mlb-photos/image/upload/w_360,q_auto:best/v1/people/${player.id}/headshot/67/current` : null),
        history, total: player.total ?? history.reduce((sum, value) => sum + value, 0),
        mean: Math.round((history.reduce((sum, value) => sum + value, 0) / history.length) * 100) / 100,
        lineProbs, evidence,
      };
    }).filter(Boolean);
    if (!result[category].length) delete result[category];
  }
  return Object.keys(result).length ? result : null;
}

// Adaptador para no romper el contrato visual actual de Baseball mientras su
// fuente matemática cambia por completo a frecuencia empírica.
export function toBaseballProbabilityShape(prediction, { playerHighlights = null, playerProbabilities, pitcherMatchup = null } = {}) {
  const totals = bareLadder(prediction.totals?.lines);
  const totalEntries = Object.keys(totals).map(Number);
  const target = Number(prediction.expected?.total);
  const bestLine = totalEntries.length
    ? totalEntries.reduce((best, line) => Math.abs(line - target) < Math.abs(best - target) ? line : best, totalEntries[0])
    : null;
  return {
    moneyline: { home: bare(prediction.moneyline?.home), away: bare(prediction.moneyline?.away) },
    totals: { bestLine, lines: totals },
    runLine: {
      home_minus_1_5: bare(prediction.spread?.homeMinus),
      away_plus_1_5: bare(prediction.spread?.awayPlus),
      away_minus_1_5: bare(prediction.spread?.awayMinus),
      home_plus_1_5: bare(prediction.spread?.homePlus),
    },
    f5: {
      moneyline: {
        home: bare(prediction.period?.moneyline?.home),
        away: bare(prediction.period?.moneyline?.away),
        tie: bare(prediction.period?.moneyline?.draw),
      },
      totals: bareLadder(prediction.period?.totals),
    },
    teamTotals: { home: bareLadder(prediction.teamTotals?.home), away: bareLadder(prediction.teamTotals?.away) },
    btts: { yes: bare(prediction.bothScore?.yes), no: bare(prediction.bothScore?.no) },
    expected: {
      lambdaHome: prediction.expected?.home == null ? null : Math.round(prediction.expected.home * 100) / 100,
      lambdaAway: prediction.expected?.away == null ? null : Math.round(prediction.expected.away * 100) / 100,
      totalRuns: prediction.expected?.total == null ? null : Math.round(prediction.expected.total * 100) / 100,
    },
    pitchers: pitcherMatchup,
    players: playerProbabilities === undefined ? buildEmpiricalPlayerProbabilities(playerHighlights) : playerProbabilities,
    evidence: prediction,
  };
}

export const multisportEngineInternals = {
  empiricalRate, displayPercent, dedupeObservations, project, ladder, percentile,
};
