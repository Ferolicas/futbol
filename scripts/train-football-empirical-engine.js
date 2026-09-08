/* eslint-disable */
// Entrenamiento walk-forward de pesos de contexto del motor empírico.
//
// No aprende una función opaca ni calibra/sube/baja probabilidades. Reproduce
// cada predicción con cutoff anterior al partido y aprende los pesos de
// localía/estadio, nivel del rival, fase, H2H, árbitro, descanso y alineación
// según Brier + calibración por horizonte
// fuera de muestra. El candidato solo se activa si no empeora al campeón.
// La actualidad parte de 65/35 y aumenta de forma explicable cuando cambia la
// plantilla; ese ajuste no participa en la rejilla de pesos contextuales.

const pg = require('pg');
const {
  computeBaseMarkets,
  DEFAULT_ENGINE_CONFIG,
  normalizeEngineConfig,
  resetEngineConfigCache,
  inferExpectedLineups,
} = require('../lib/model-engine.js');
const {
  calibrateProbability,
  probabilityValidationBand,
} = require('../lib/prediction-math.cjs');

// Rejilla pequeña y explicable. Cada valor es un peso sobre partidos reales;
// nunca un ajuste directo de puntos porcentuales.
const CONFIG_GRID = Object.freeze({
  venueBoost: [1.00, 1.08, 1.18, 1.28, 1.40],
  stadiumBoost: [1.00, 1.04, 1.08, 1.14],
  opponentTierBoost: [1.00, 1.05, 1.10, 1.20, 1.30],
  phaseBoost: [1.00, 1.03, 1.06, 1.12, 1.20],
  h2hBoost: [1.00, 1.10, 1.22, 1.35, 1.50],
  refereeBoost: [1.00, 1.05, 1.10, 1.20, 1.30],
  lineupBoost: [1.00, 1.08, 1.18, 1.30, 1.50, 1.80, 2.20],
  restBoost: [1.00, 1.05, 1.10, 1.20, 1.35],
});
const MARKET_KEY = '__empirical_engine__';
const EPS = 1e-6;
const lineDiagnosticKey = (marketKey, direction, line) =>
  `${marketKey}_${direction}_${String(line).replace('.', '_')}`;

const num = (x) => x == null ? null : Number(x);
const add = (a, b) => a == null || b == null ? null : Number(a) + Number(b);
const cardsOne = (y, r) => y == null ? null : Number(y) + Number(r || 0);
const cardsTotal = (r) => r.yellow_for == null || r.yellow_against == null ? null
  : Number(r.yellow_for) + Number(r.yellow_against) + Number(r.red_for || 0) + Number(r.red_against || 0);

const OU_ACTUAL = {
  goals: { total: (r) => add(r.ft_home, r.ft_away), home: (r) => num(r.ft_home), away: (r) => num(r.ft_away) },
  corners: { total: (r) => add(r.corners_for, r.corners_against), home: (r) => num(r.corners_for), away: (r) => num(r.corners_against) },
  cards: { total: cardsTotal, home: (r) => cardsOne(r.yellow_for, r.red_for), away: (r) => cardsOne(r.yellow_against, r.red_against) },
  shots: { total: (r) => add(r.shots_for, r.shots_against), home: (r) => num(r.shots_for), away: (r) => num(r.shots_against) },
  sot: { total: (r) => add(r.sot_for, r.sot_against), home: (r) => num(r.sot_for), away: (r) => num(r.sot_against) },
  fouls: { total: (r) => add(r.fouls_for, r.fouls_against), home: (r) => num(r.fouls_for), away: (r) => num(r.fouls_against) },
  offsides: { total: (r) => add(r.offsides_for, r.offsides_against), home: (r) => num(r.offsides_for), away: (r) => num(r.offsides_against) },
  goals_1h: { total: (r) => add(r.gf_1h, r.ga_1h), home: (r) => num(r.gf_1h), away: (r) => num(r.ga_1h) },
  goals_2h: { total: (r) => add(r.gf_2h, r.ga_2h), home: (r) => num(r.gf_2h), away: (r) => num(r.ga_2h) },
};

const BOOL_ACTUAL = {
  btts: (r) => r.ft_home == null || r.ft_away == null ? null : (Number(r.ft_home) > 0 && Number(r.ft_away) > 0 ? 1 : 0),
  clean_sheet_home: (r) => r.ft_away == null ? null : (Number(r.ft_away) === 0 ? 1 : 0),
  clean_sheet_away: (r) => r.ft_home == null ? null : (Number(r.ft_home) === 0 ? 1 : 0),
  red_card_home: (r) => r.red_for == null ? null : (Number(r.red_for) > 0 ? 1 : 0),
  red_card_away: (r) => r.red_against == null ? null : (Number(r.red_against) > 0 ? 1 : 0),
  red_card_any: (r) => r.red_for == null || r.red_against == null ? null : (Number(r.red_for) + Number(r.red_against) > 0 ? 1 : 0),
  first_goal_1h: (r) => {
    if (r.first_goal_minute != null) return Number(r.first_goal_minute) <= 45 ? 1 : 0;
    if (r.ft_home != null && r.ft_away != null && Number(r.ft_home) + Number(r.ft_away) === 0) return 0;
    return null;
  },
};

function probabilityForShare(chain, share) {
  const step = Array.isArray(chain) ? chain.find((x) => x.step === 'empirical-weighted') : null;
  if (!step) return null;
  if (Array.isArray(step.teams) && step.teams.length) {
    const teamProbabilities = step.teams.map((team) => {
      const cp = num(team.current?.p), hp = num(team.historical?.p);
      const cn = Number(team.current?.n || 0), hn = Number(team.historical?.n || 0);
      if (cn && hn) return share * cp + (1 - share) * hp;
      if (cn) return cp;
      if (hn) return hp;
      return null;
    }).filter((probability) => probability != null);
    return teamProbabilities.length
      ? teamProbabilities.reduce((sum, probability) => sum + probability, 0) / teamProbabilities.length
      : null;
  }
  const cp = num(step.current?.p), hp = num(step.historical?.p);
  const cn = Number(step.current?.n || 0), hn = Number(step.historical?.n || 0);
  if (cn && hn) return share * cp + (1 - share) * hp;
  if (cn) return cp;
  if (hn) return hp;
  return null;
}

function observations(markets, actual) {
  const out = [];
  for (const [key, market] of Object.entries(markets || {})) {
    if (!market) continue;
    if (key === '1x2' && market.kind === 'result' && ['H', 'D', 'A'].includes(actual.result)) {
      out.push({ family: '1x2_home', prob: market.home, hit: actual.result === 'H' ? 1 : 0 });
      out.push({ family: '1x2_draw', prob: market.draw, hit: actual.result === 'D' ? 1 : 0 });
      out.push({ family: '1x2_away', prob: market.away, hit: actual.result === 'A' ? 1 : 0 });
    } else if (market.kind === 'ou') {
      const match = key.match(/^(.+)_(total|home|away)$/);
      if (!match) continue;
      const extractor = OU_ACTUAL[match[1]]?.[match[2]];
      const value = extractor ? extractor(actual) : null;
      if (value == null) continue;
      for (const line of market.lines || []) {
        const overHit = Number(value) > Number(line.line) ? 1 : 0;
        out.push({ family: lineDiagnosticKey(key, 'over', line.line), prob: line.prob, chain: line.chain, hit: overHit });
        out.push({ family: lineDiagnosticKey(key, 'under', line.line), prob: line.prob == null ? null : 1 - Number(line.prob), chain: line.chain, hit: 1 - overHit });
      }
    } else if (market.kind === 'bool' && BOOL_ACTUAL[key]) {
      const hit = BOOL_ACTUAL[key](actual);
      if (hit != null) out.push({ family: key, prob: market.prob, chain: market.chain, hit });
      if (key === 'btts' && hit != null) out.push({ family: 'btts_no', prob: market.prob == null ? null : 1 - Number(market.prob), chain: market.chain, hit: 1 - hit });
    } else if (market.kind === 'multi' && key === 'double_chance' && ['H', 'D', 'A'].includes(actual.result)) {
      out.push({ family: 'dc_1x', prob: market['1X'], hit: actual.result !== 'A' ? 1 : 0 });
      out.push({ family: 'dc_12', prob: market['12'], hit: actual.result !== 'D' ? 1 : 0 });
      out.push({ family: 'dc_x2', prob: market.X2, hit: actual.result !== 'H' ? 1 : 0 });
    } else if (market.kind === 'multi' && key === 'odd_even' && actual.ft_home != null && actual.ft_away != null) {
      const even = (Number(actual.ft_home) + Number(actual.ft_away)) % 2 === 0 ? 1 : 0;
      out.push({ family: 'goals_even', prob: market.even, hit: even });
      out.push({ family: 'goals_odd', prob: market.odd, hit: 1 - even });
    } else if (market.kind === 'multi' && key === 'handicap_home_asian' && actual.ft_home != null && actual.ft_away != null) {
      const difference = Number(actual.ft_home) - Number(actual.ft_away);
      for (const [suffix, hit] of Object.entries({ m0_5: difference >= 1, m1_5: difference >= 2, p0_5: difference >= 0, p1_5: difference >= -1 })) {
        out.push({ family: `ah_home_${suffix}`, prob: market[suffix.replace('_', '.')], hit: hit ? 1 : 0 });
      }
    } else if (market.kind === 'multi' && key === 'handicap_home_eu' && actual.ft_home != null && actual.ft_away != null) {
      const difference = Number(actual.ft_home) - Number(actual.ft_away);
      out.push({ family: 'eh_home_m1', prob: market.m1, hit: difference >= 2 ? 1 : 0 });
      out.push({ family: 'eh_home_p1', prob: market.p1, hit: difference >= 0 ? 1 : 0 });
    } else if (market.kind === 'list' && key === 'exact_score' && actual.ft_home != null && actual.ft_away != null) {
      const home = Number(actual.ft_home), away = Number(actual.ft_away), total = home + away;
      for (const line of market.lines || []) {
        out.push({ family: `cs_${String(line.score).replace('-', '_')}`, prob: line.prob, hit: line.score === `${home}-${away}` ? 1 : 0 });
      }
      for (const [bucket, probability] of Object.entries(market.totalProbabilities || {})) {
        out.push({ family: `exact_goals_${bucket}`, prob: probability, hit: bucket === '7plus' ? (total >= 7 ? 1 : 0) : (total === Number(bucket) ? 1 : 0) });
      }
    }
  }
  return out;
}

function emptyMetric() {
  return {
    n: 0, brierSum: 0, loglossSum: 0, absGapSum: 0,
    selectable70N: 0, selectable70Pred: 0, selectable70Hits: 0,
    highN: 0, highPred: 0, highHits: 0,
    daily90N: 0, daily90Pred: 0, daily90Hits: 0,
    eliteN: 0, elitePred: 0, eliteHits: 0,
    byFamily: {},
  };
}

function addObservation(metric, family, p, hit) {
  if (p == null || hit == null || !Number.isFinite(p)) return;
  // Se puntúa la frecuencia real completa. EPS solo evita log(0); no modifica
  // el porcentaje servido ni introduce un tope comercial.
  const q = Math.max(EPS, Math.min(1 - EPS, p));
  metric.n++;
  metric.brierSum += (q - hit) ** 2;
  metric.loglossSum += -(hit * Math.log(q) + (1 - hit) * Math.log(1 - q));
  metric.absGapSum += Math.abs(q - hit);
  if (q >= 0.70) { metric.selectable70N++; metric.selectable70Pred += q; metric.selectable70Hits += hit; }
  if (q >= 0.80) { metric.highN++; metric.highPred += q; metric.highHits += hit; }
  if (q >= 0.90) { metric.daily90N++; metric.daily90Pred += q; metric.daily90Hits += hit; }
  if (q >= 0.95) { metric.eliteN++; metric.elitePred += q; metric.eliteHits += hit; }
  const f = metric.byFamily[family] || (metric.byFamily[family] = {
    n: 0, pred: 0, hits: 0, brier: 0,
    selectable70N: 0, selectable70Pred: 0, selectable70Hits: 0,
    highN: 0, highPred: 0, highHits: 0,
    daily90N: 0, daily90Pred: 0, daily90Hits: 0,
    eliteN: 0, elitePred: 0, eliteHits: 0,
  });
  f.n++; f.pred += q; f.hits += hit; f.brier += (q - hit) ** 2;
  if (q >= 0.70) { f.selectable70N++; f.selectable70Pred += q; f.selectable70Hits += hit; }
  if (q >= 0.80) { f.highN++; f.highPred += q; f.highHits += hit; }
  if (q >= 0.90) { f.daily90N++; f.daily90Pred += q; f.daily90Hits += hit; }
  if (q >= 0.95) { f.eliteN++; f.elitePred += q; f.eliteHits += hit; }
}

function finishMetric(metric) {
  const families = {};
  for (const [key, f] of Object.entries(metric.byFamily)) {
    families[key] = {
      n: f.n, avg_pred: f.pred / f.n, avg_actual: f.hits / f.n, brier: f.brier / f.n,
      selectable70: f.selectable70N ? { n: f.selectable70N, avg_pred: f.selectable70Pred / f.selectable70N, avg_actual: f.selectable70Hits / f.selectable70N } : { n: 0 },
      high: f.highN ? { n: f.highN, avg_pred: f.highPred / f.highN, avg_actual: f.highHits / f.highN } : { n: 0 },
      daily90: f.daily90N ? { n: f.daily90N, avg_pred: f.daily90Pred / f.daily90N, avg_actual: f.daily90Hits / f.daily90N } : { n: 0 },
      elite95: f.eliteN ? { n: f.eliteN, avg_pred: f.elitePred / f.eliteN, avg_actual: f.eliteHits / f.eliteN } : { n: 0 },
    };
  }
  return {
    n: metric.n,
    brier: metric.n ? metric.brierSum / metric.n : null,
    logloss: metric.n ? metric.loglossSum / metric.n : null,
    mean_abs_error: metric.n ? metric.absGapSum / metric.n : null,
    selectable70: metric.selectable70N ? { n: metric.selectable70N, avg_pred: metric.selectable70Pred / metric.selectable70N, avg_actual: metric.selectable70Hits / metric.selectable70N, gap: Math.abs(metric.selectable70Pred - metric.selectable70Hits) / metric.selectable70N } : { n: 0 },
    high: metric.highN ? { n: metric.highN, avg_pred: metric.highPred / metric.highN, avg_actual: metric.highHits / metric.highN, gap: Math.abs(metric.highPred - metric.highHits) / metric.highN } : { n: 0 },
    daily90: metric.daily90N ? { n: metric.daily90N, avg_pred: metric.daily90Pred / metric.daily90N, avg_actual: metric.daily90Hits / metric.daily90N, gap: Math.abs(metric.daily90Pred - metric.daily90Hits) / metric.daily90N } : { n: 0 },
    elite95: metric.eliteN ? { n: metric.eliteN, avg_pred: metric.elitePred / metric.eliteN, avg_actual: metric.eliteHits / metric.eliteN, gap: Math.abs(metric.elitePred - metric.eliteHits) / metric.eliteN } : { n: 0 },
    families,
  };
}

function calibrationEvidence(probability, family, calibrationFamilies) {
  const metric = calibrationFamilies?.[family];
  const band = probabilityValidationBand(probability);
  const segment = band === 'all' ? metric : metric?.[band];
  return {
    available: !!segment,
    family,
    band,
    n: Number(segment?.n || 0),
    avgPred: segment?.avg_pred == null ? null : Number(segment.avg_pred),
    avgActual: segment?.avg_actual == null ? null : Number(segment.avg_actual),
  };
}

/** Ajusta validation con train y devuelve métricas realmente fuera de muestra. */
function calibrateValidationObservations(trainMetric, validationMetric, validationObservations) {
  const train = finishMetric(trainMetric);
  const raw = finishMetric(validationMetric);
  const calibratedMetric = emptyMetric();
  for (const observation of validationObservations || []) {
    const calibration = calibrationEvidence(
      observation.prob,
      observation.family,
      train.families,
    );
    const probability = calibrateProbability(observation.prob, calibration);
    addObservation(calibratedMetric, observation.family, probability, observation.hit);
  }
  return {
    ...finishMetric(calibratedMetric),
    calibrationFamilies: train.families,
    raw,
  };
}

function metricScore(metric) {
  if (!metric || metric.brier == null) return Infinity;
  return metric.brier
    + (metric.high?.gap || 0) * 0.25
    + (metric.daily90?.gap || 0) * 0.35
    + (metric.elite95?.gap || 0) * 0.50;
}

async function upsertDiagnostics(pool, families) {
  // Snapshot completo: elimina claves/segmentos de versiones anteriores para
  // que una familia agregada obsoleta jamás conserve autorización comercial.
  await pool.query(
    `DELETE FROM market_segment_diagnostics
     WHERE sport='football' AND segment LIKE 'validation%'`
  );
  const rows = [];
  for (const [family, fm] of Object.entries(families || {})) {
    const segments = [
      { name: 'validation', ...fm },
      { name: 'validation-selectable70', ...fm.selectable70, brier: null },
      { name: 'validation-high', ...fm.high, brier: null },
      { name: 'validation-daily90', ...fm.daily90, brier: null },
      { name: 'validation-elite95', ...fm.elite95, brier: null },
    ];
    for (const segment of segments) {
      const avgPred = segment.avg_pred == null ? null : Number(segment.avg_pred);
      const avgActual = segment.avg_actual == null ? null : Number(segment.avg_actual);
      const gap = avgPred == null || avgActual == null ? null : Math.abs(avgPred - avgActual);
      rows.push({
        market_key: family,
        segment: segment.name,
        sample_n: Number(segment.n || 0),
        avg_pred: avgPred,
        avg_actual: avgActual,
        brier: segment.brier ?? null,
        calibration_error: gap,
      });
    }
  }
  if (!rows.length) return;
  // Un único round-trip set-based en vez de 3 escrituras por familia. En la
  // validación actual son 2.265 filas y la transacción queda mucho más corta.
  await pool.query(
    `INSERT INTO market_segment_diagnostics
       (sport,market_key,segment,sample_n,avg_pred,avg_actual,brier,calibration_error,updated_at)
     SELECT 'football',x.market_key,x.segment,x.sample_n,x.avg_pred,x.avg_actual,
            x.brier,x.calibration_error,NOW()
     FROM jsonb_to_recordset($1::jsonb) AS x(
       market_key text,segment text,sample_n int,avg_pred real,avg_actual real,
       brier real,calibration_error real
     )
     ON CONFLICT(sport,market_key,segment) DO UPDATE SET
       sample_n=EXCLUDED.sample_n,avg_pred=EXCLUDED.avg_pred,
       avg_actual=EXCLUDED.avg_actual,brier=EXCLUDED.brier,
       calibration_error=EXCLUDED.calibration_error,updated_at=NOW()`,
    [JSON.stringify(rows)]
  );
}

const configKeys = Object.keys(CONFIG_GRID);
const sameConfig = (a, b) => configKeys.every((key) => Number(a?.[key]) === Number(b?.[key]));

async function evaluateConfig(samples, config, split, baselineConfig) {
  const metric = {
    train: emptyMetric(), validation: emptyMetric(),
    trainEarly: emptyMetric(), validationEarly: emptyMetric(),
    trainProbable: emptyMetric(), validationProbable: emptyMetric(),
    trainConfirmed: emptyMetric(), validationConfirmed: emptyMetric(),
  };
  const calibrated = {
    all: emptyMetric(), early: emptyMetric(), probable: emptyMetric(), confirmed: emptyMetric(),
  };
  let calibrationFamilies = null;
  const beginValidation = () => {
    if (calibrationFamilies) return;
    calibrationFamilies = {
      all: finishMetric(metric.train).families,
      early: finishMetric(metric.trainEarly).families,
      probable: finishMetric(metric.trainProbable).families,
      confirmed: finishMetric(metric.trainConfirmed).families,
    };
  };
  const addCalibratedObservation = (horizon, observation) => {
    const allProbability = calibrateProbability(
      observation.prob,
      calibrationEvidence(observation.prob, observation.family, calibrationFamilies.all),
    );
    addObservation(calibrated.all, observation.family, allProbability, observation.hit);
    const horizonProbability = calibrateProbability(
      observation.prob,
      calibrationEvidence(observation.prob, observation.family, calibrationFamilies[horizon]),
    );
    addObservation(calibrated[horizon], observation.family, horizonProbability, observation.hit);
  };
  for (let i = 0; i < samples.length; i++) {
    // Las muestras están ordenadas cronológicamente. Cuando comienza la
    // partición de validación, train ya está completo y sus familias pueden
    // congelarse. Así calibramos cada observación una sola vez, sin retener en
    // memoria cientos de miles de objetos para recorrerlos de nuevo al final.
    if (i === split) beginValidation();
    const sample = samples[i];
    const target = i < split ? metric.train : metric.validation;
    const earlyTarget = i < split ? metric.trainEarly : metric.validationEarly;
    const probableTarget = i < split ? metric.trainProbable : metric.validationProbable;
    const confirmedTarget = i < split ? metric.trainConfirmed : metric.validationConfirmed;
    const earlyMarkets = sameConfig(config, baselineConfig)
      ? sample.earlyBaselineMarkets
      : (await computeBaseMarkets(null, sample.ctx, { config, rawRows: sample.earlyRawRows })).markets;
    for (const observation of observations(earlyMarkets, sample.actual)) {
      addObservation(target, observation.family, observation.prob, observation.hit);
      addObservation(earlyTarget, observation.family, observation.prob, observation.hit);
      if (i >= split) addCalibratedObservation('early', observation);
    }
    if (sample.probableRawRows) {
      const probableMarkets = sameConfig(config, baselineConfig)
        ? sample.probableBaselineMarkets
        : (await computeBaseMarkets(null, sample.ctx, { config, rawRows: sample.probableRawRows })).markets;
      for (const observation of observations(probableMarkets, sample.actual)) {
        addObservation(target, observation.family, observation.prob, observation.hit);
        addObservation(probableTarget, observation.family, observation.prob, observation.hit);
        if (i >= split) addCalibratedObservation('probable', observation);
      }
    }
    if (sample.confirmedRawRows) {
      const confirmedMarkets = sameConfig(config, baselineConfig)
        ? sample.confirmedBaselineMarkets
        : (await computeBaseMarkets(null, sample.ctx, { config, rawRows: sample.confirmedRawRows })).markets;
      for (const observation of observations(confirmedMarkets, sample.actual)) {
        addObservation(target, observation.family, observation.prob, observation.hit);
        addObservation(confirmedTarget, observation.family, observation.prob, observation.hit);
        if (i >= split) addCalibratedObservation('confirmed', observation);
      }
    }
  }
  beginValidation();
  const calibratedMetric = (value, families, rawValue) => ({
    ...finishMetric(value),
    calibrationFamilies: families,
    raw: finishMetric(rawValue),
  });
  const validation = calibratedMetric(calibrated.all, calibrationFamilies.all, metric.validation);
  return {
    train: finishMetric(metric.train),
    validation: {
      ...validation,
      horizons: {
        early: calibratedMetric(calibrated.early, calibrationFamilies.early, metric.validationEarly),
        probable: calibratedMetric(calibrated.probable, calibrationFamilies.probable, metric.validationProbable),
        confirmed: calibratedMetric(calibrated.confirmed, calibrationFamilies.confirmed, metric.validationConfirmed),
      },
    },
  };
}

async function loadActiveConfig(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT version,weights,metrics FROM prediction_models
       WHERE sport='football' AND market_key=$1 AND model_type='empirical-weighting' AND active=TRUE
       ORDER BY version DESC LIMIT 1`, [MARKET_KEY]);
    if (rows[0]) return { version: Number(rows[0].version), config: normalizeEngineConfig(rows[0].weights), metrics: rows[0].metrics };
  } catch {}
  return { version: 0, config: normalizeEngineConfig(DEFAULT_ENGINE_CONFIG), metrics: null };
}

async function trainFootballEmpiricalEngine({ pool: externalPool = null, limit = 1200, dry = false, fixedConfig = null } = {}) {
  const ownPool = !externalPool;
  const pool = externalPool || new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 3,
  });
  try {
    const active = await loadActiveConfig(pool);
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT m.fixture_id,m.home_team_id,m.away_team_id,m.competition_id,m.season,m.phase,m.kickoff,m.referee,
                m.home_rank_before,m.away_rank_before,cs.n_teams,m.venue_id,m.ft_home,m.ft_away,m.result,
                t.corners_for,t.corners_against,t.shots_for,t.shots_against,t.sot_for,t.sot_against,
                t.fouls_for,t.fouls_against,t.offsides_for,t.offsides_against,
                t.yellow_for,t.yellow_against,t.red_for,t.red_against,t.gf_1h,t.ga_1h,t.gf_2h,t.ga_2h,
                t.first_goal_minute
         FROM model.matches m
         JOIN model.team_match_stats t ON t.fixture_id=m.fixture_id AND t.team_id=m.home_team_id
         LEFT JOIN model.competition_seasons cs ON cs.competition_id=m.competition_id AND cs.season=m.season
         WHERE m.result IS NOT NULL AND m.ft_home IS NOT NULL AND m.ft_away IS NOT NULL
         ORDER BY m.kickoff DESC LIMIT $1
       ) sample ORDER BY kickoff ASC`, [Number(limit)]);

    // XI real del partido objetivo. Al calcular cada muestra con cutoff=kickoff,
    // estos jugadores solo ponderan alineaciones históricas anteriores; la
    // alineación/resultado objetivo nunca entra en sus propios antecedentes.
    const targetLineups = new Map();
    if (rows.length) {
      const fixtureIds = rows.map((row) => Number(row.fixture_id));
      const { rows: lineupRows } = await pool.query(
        `SELECT fixture_id,team_id,player_id
         FROM model.lineups
         WHERE fixture_id=ANY($1::bigint[]) AND is_starter=TRUE
         ORDER BY fixture_id,team_id,player_id`, [fixtureIds]);
      for (const row of lineupRows) {
        const fid = Number(row.fixture_id), teamId = Number(row.team_id);
        if (!targetLineups.has(fid)) targetLineups.set(fid, new Map());
        const teams = targetLineups.get(fid);
        if (!teams.has(teamId)) teams.set(teamId, []);
        teams.get(teamId).push({ player: { id: Number(row.player_id) } });
      }
    }
    const lineupsFor = (fixtureId) => [...(targetLineups.get(Number(fixtureId)) || new Map()).entries()]
      .map(([teamId, startXI]) => ({ team: { id: teamId }, startXI, substitutes: [] }));

    const samples = [];
    let errors = 0;
    let lineupSamples = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ctx = {
        fixtureId: Number(row.fixture_id), homeTeamId: Number(row.home_team_id), awayTeamId: Number(row.away_team_id),
        competitionId: Number(row.competition_id), season: row.season == null ? null : Number(row.season),
        phase: row.phase, referee: row.referee || null,
        venueId: row.venue_id == null ? null : Number(row.venue_id),
        nTeams: row.n_teams == null ? null : Number(row.n_teams),
        homeRank: row.home_rank_before == null ? null : Number(row.home_rank_before),
        awayRank: row.away_rank_before == null ? null : Number(row.away_rank_before), cutoff: new Date(row.kickoff),
      };
      try {
        const currentLineups = lineupsFor(row.fixture_id);
        // Se validan dos horizontes separados. El análisis temprano jamás ve
        // el XI objetivo; el confirmado sí puede usar la alineación que habría
        // estado disponible antes del partido. Ambos respetan cutoff=kickoff.
        let earlyResult = await computeBaseMarkets(pool, ctx, {
          config: active.config,
          includeRawRows: true,
          currentLineups: null,
        });
        const kickoffMs = new Date(row.kickoff).getTime();
        const lastKickoff = (items) => items.reduce((latest, item) => Math.max(latest, new Date(item.kickoff).getTime()), 0);
        const homePrevious = lastKickoff(earlyResult.rawRows?.homeRaw || []);
        const awayPrevious = lastKickoff(earlyResult.rawRows?.awayRaw || []);
        ctx.homeRestDays = homePrevious ? (kickoffMs - homePrevious) / 86400000 : null;
        ctx.awayRestDays = awayPrevious ? (kickoffMs - awayPrevious) / 86400000 : null;
        // Reusa las filas ya leídas para que el baseline incorpore el contexto
        // de descanso exactamente como serving.
        earlyResult = await computeBaseMarkets(null, ctx, {
          config: active.config,
          includeRawRows: true,
          rawRows: earlyResult.rawRows,
        });
        const probableLineups = await inferExpectedLineups(pool, ctx).catch(() => []);
        const probableResult = probableLineups.length
          ? await computeBaseMarkets(pool, ctx, {
            config: active.config,
            includeRawRows: true,
            currentLineups: probableLineups,
          })
          : null;
        let confirmedResult = null;
        if (currentLineups.length) {
          confirmedResult = await computeBaseMarkets(pool, ctx, {
            config: active.config,
            includeRawRows: true,
            currentLineups,
          });
          if (Number(confirmedResult.fixture?.lineupContext?.historicalRows || 0) > 0) lineupSamples++;
        }
        samples.push({
          ctx, actual: row,
          earlyRawRows: earlyResult.rawRows,
          earlyBaselineMarkets: earlyResult.markets,
          probableRawRows: probableResult?.rawRows || null,
          probableBaselineMarkets: probableResult?.markets || null,
          confirmedRawRows: confirmedResult?.rawRows || null,
          confirmedBaselineMarkets: confirmedResult?.markets || null,
        });
      } catch (error) {
        errors++;
        if (errors <= 5) console.error(`[train-football-empirical] fixture ${row.fixture_id}: ${error.message}`);
      }
    }

    if (samples.length < 2) throw new Error(`muestra de entrenamiento insuficiente: ${samples.length}`);
    const split = Math.max(1, Math.min(samples.length - 1, Math.floor(samples.length * 0.70)));
    const baseline = await evaluateConfig(samples, active.config, split, active.config);

    // Descenso coordinado: cada dimensión se elige únicamente en train. El
    // conjunto validation no decide pesos; solo acepta/rechaza el candidato.
    let config = normalizeEngineConfig(fixedConfig || active.config);
    const steps = [];
    let candidate = baseline;
    for (const [parameter, grid] of fixedConfig ? [] : Object.entries(CONFIG_GRID)) {
      const values = [...new Set([...grid, Number(config[parameter])])].sort((a, b) => a - b);
      const trials = [];
      for (const value of values) {
        const trialConfig = normalizeEngineConfig({ ...config, [parameter]: value });
        const evaluated = await evaluateConfig(samples, trialConfig, split, active.config);
        trials.push({ value: Number(trialConfig[parameter]), evaluated, score: metricScore(evaluated.train) });
      }
      trials.sort((a, b) => a.score - b.score || a.value - b.value);
      const winner = trials[0];
      const previous = Number(config[parameter]);
      config = normalizeEngineConfig({ ...config, [parameter]: winner.value });
      candidate = winner.evaluated;
      steps.push({
        parameter, previous, chosen: winner.value,
        trainScore: winner.score, validationScore: metricScore(winner.evaluated.validation),
        trials: trials.map((t) => ({ value: t.value, trainScore: t.score, validationScore: metricScore(t.evaluated.validation) })),
      });
    }
    // Recalcular una vez con la configuración completa final: el resultado del
    // último paso ya coincide, pero esto mantiene el contrato si cambia el orden.
    candidate = await evaluateConfig(samples, config, split, active.config);
    const configChanged = !sameConfig(config, active.config);
    const baselineEliteGap = baseline.validation.elite95?.n ? baseline.validation.elite95.gap : null;
    const candidateEliteGap = candidate.validation.elite95?.n ? candidate.validation.elite95.gap : null;
    const baselineDaily90Gap = baseline.validation.daily90?.n ? baseline.validation.daily90.gap : null;
    const candidateDaily90Gap = candidate.validation.daily90?.n ? candidate.validation.daily90.gap : null;
    const daily90NotWorse = candidateDaily90Gap == null || baselineDaily90Gap == null || candidateDaily90Gap <= baselineDaily90Gap + 1e-9;
    const eliteNotWorse = candidateEliteGap == null || baselineEliteGap == null || candidateEliteGap <= baselineEliteGap + 1e-9;
    const earlyNotWorse = metricScore(candidate.validation.horizons?.early)
      <= metricScore(baseline.validation.horizons?.early) + 1e-9;
    const confirmedHasSample = Number(candidate.validation.horizons?.confirmed?.n || 0) > 0;
    const probableHasSample = Number(candidate.validation.horizons?.probable?.n || 0) > 0;
    const probableNotWorse = !probableHasSample || metricScore(candidate.validation.horizons?.probable)
      <= metricScore(baseline.validation.horizons?.probable) + 1e-9;
    const confirmedNotWorse = !confirmedHasSample || metricScore(candidate.validation.horizons?.confirmed)
      <= metricScore(baseline.validation.horizons?.confirmed) + 1e-9;
    const notWorse = metricScore(candidate.validation) <= metricScore(baseline.validation) + 1e-9
      && daily90NotWorse && eliteNotWorse && earlyNotWorse && probableNotWorse && confirmedNotWorse;
    const activates = active.version === 0 ? notWorse : (configChanged && notWorse);
    const shouldPersist = active.version === 0 || configChanged;
    const report = {
      processed: samples.length, errors, sample: rows.length, lineupSamples,
      train: split, validation: samples.length - split,
      previousVersion: active.version, previousShare: active.config.currentShare,
      previousConfig: active.config, candidateShare: config.currentShare,
      candidateConfig: config, configChanged, activates, daily90NotWorse, eliteNotWorse,
      earlyNotWorse, probableNotWorse, confirmedNotWorse, steps,
      baseline: baseline.validation, candidate: candidate.validation,
    };

    if (!dry && shouldPersist) {
      const { rows: versions } = await pool.query(
        `SELECT COALESCE(MAX(version),0)::int+1 AS next FROM prediction_models WHERE sport='football' AND market_key=$1`,
        [MARKET_KEY]);
      const version = Number(versions[0]?.next || 1);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (activates) await client.query(
          `UPDATE prediction_models SET active=FALSE WHERE sport='football' AND market_key=$1 AND model_type='empirical-weighting'`,
          [MARKET_KEY]);
        await client.query(
          `INSERT INTO prediction_models(sport,market_key,version,model_type,weights,metrics,active,trained_at)
           VALUES ('football',$1,$2,'empirical-weighting',$3::jsonb,$4::jsonb,$5,NOW())`,
          [MARKET_KEY, version, JSON.stringify(config), JSON.stringify(report), activates]);
        if (activates) {
          await upsertDiagnostics(client, candidate.validation.families);
        } else if (active.version > 0) {
          // El candidato queda auditado como inactivo, pero producción conserva
          // al campeón. Renovamos SU validación con la ventana más reciente;
          // de otro modo los diagnósticos del campeón quedarían desactualizados.
          const servedReport = {
            ...report,
            candidateShare: active.config.currentShare,
            candidateConfig: active.config,
            configChanged: false,
            activates: false,
            steps: [],
            candidate: baseline.validation,
            rejectedCandidate: {
              config,
              brier: candidate.validation.brier,
              high: candidate.validation.high,
              daily90: candidate.validation.daily90,
              elite95: candidate.validation.elite95,
            },
          };
          await client.query(
            `UPDATE prediction_models SET metrics=$1::jsonb,trained_at=NOW()
             WHERE sport='football' AND market_key=$2 AND version=$3 AND active=TRUE`,
            [JSON.stringify(servedReport), MARKET_KEY, active.version]
          );
          await upsertDiagnostics(client, baseline.validation.families);
        }
        await client.query('COMMIT');
        report.version = version;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } else if (!dry) {
      report.version = active.version;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE prediction_models SET metrics=$1::jsonb,trained_at=NOW()
           WHERE sport='football' AND market_key=$2 AND version=$3 AND active=TRUE`,
          [JSON.stringify(report), MARKET_KEY, active.version]);
        await upsertDiagnostics(client, candidate.validation.families);
        await client.query('COMMIT');
        report.persisted = 'metrics-refreshed';
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    // La caché contiene también métricas. Debe invalidarse aunque los pesos no
    // cambien; de lo contrario el reanálisis inmediato seguiría usando durante
    // cinco minutos la calibración anterior que acabamos de reemplazar.
    if (!dry) resetEngineConfigCache();
    console.log(`[train-football-empirical] sample=${rows.length} processed=${samples.length} errors=${errors} · share ${active.config.currentShare}→${config.currentShare} · activate=${activates} · valBrier=${candidate.validation.brier?.toFixed(4)} · daily90=${candidate.validation.daily90?.avg_actual == null ? '—' : (candidate.validation.daily90.avg_actual * 100).toFixed(1) + '%'} · elite95=${candidate.validation.elite95?.avg_actual == null ? '—' : (candidate.validation.elite95.avg_actual * 100).toFixed(1) + '%'}`);
    return report;
  } finally {
    if (ownPool) await pool.end();
  }
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true]; }));
  trainFootballEmpiricalEngine({ limit: Number(args.limit || 1200), dry: !!args.dry })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error('FATAL', error); process.exit(1); });
}

module.exports = {
  trainFootballEmpiricalEngine,
  probabilityForShare,
  observations,
  calibrateValidationObservations,
  evaluateConfig,
  upsertDiagnostics,
};
