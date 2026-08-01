/* eslint-disable */
// Entrenamiento walk-forward independiente para baseball, basketball y NFL.
// Selecciona pesos solo en 70% cronológico; el 30% final únicamente acepta o
// rechaza. La salida no calibra ni altera probabilidades: guarda pesos de
// semejanza y un gate de acierto exacto para recomendaciones.

import pg from 'pg';
import {
  DEFAULT_MULTISPORT_ENGINE_CONFIG,
  computeMultisportEmpiricalPrediction,
  normalizeMultisportEngineConfig,
  resetMultisportEngineConfigCache,
} from '../lib/multisport-empirical-engine.js';
import { getMultisportConfig } from '../lib/multisport-config.js';

const MARKET_KEY = '__empirical_engine__';
const { Pool } = pg;

const GRID = [
  DEFAULT_MULTISPORT_ENGINE_CONFIG,
  { ...DEFAULT_MULTISPORT_ENGINE_CONFIG, currentShare: 0.60 },
  { ...DEFAULT_MULTISPORT_ENGINE_CONFIG, currentShare: 0.82 },
  { ...DEFAULT_MULTISPORT_ENGINE_CONFIG, opponentBoost: 1.10, starterBoost: 1.10 },
  { ...DEFAULT_MULTISPORT_ENGINE_CONFIG, opponentBoost: 1.35, starterBoost: 1.30 },
  { ...DEFAULT_MULTISPORT_ENGINE_CONFIG, venueBoost: 1.08, competitionBoost: 1.02 },
];

function fixtureFromRow(row) {
  return {
    id: String(row.fixture_id), providerFixtureId: String(row.provider_fixture_id),
    dataProvider: row.provider, date: row.kickoff, season: String(row.season || ''),
    league: { id: String(row.competition_id || ''), name: '' },
    status: { short: 'FT', isFinal: true, isLive: false },
    teams: {
      home: { id: String(row.home_team_id), name: row.home_team || 'Home' },
      away: { id: String(row.away_team_id), name: row.away_team || 'Away' },
    },
    scores: { home: { total: Number(row.home_score) }, away: { total: Number(row.away_score) } },
    periods: row.periods || {}, context: { home: {}, away: {} },
  };
}

function emptyMetric() {
  return { squaredError: 0, n: 0, recommendations: new Map() };
}

function observe(metric, key, probability, actual) {
  const raw = Number(probability);
  if (!Number.isFinite(raw)) return;
  // Se valida exactamente el porcentaje servido: toda frecuencia superior al
  // 95% se presenta como 95% para no comunicar una garantía.
  const p = Math.max(0, Math.min(0.95, raw));
  metric.squaredError += (p - actual) ** 2;
  metric.n++;
  if (p < 0.80) return;
  const current = metric.recommendations.get(key) || { n: 0, hits: 0, predicted: 0 };
  current.n++;
  current.hits += actual;
  current.predicted += p;
  metric.recommendations.set(key, current);
}

function lineKey(value) {
  return String(value).replace('-', 'm').replace('.', '_');
}

function addPrediction(metric, prediction, row) {
  const homeScore = Number(row.home_score), awayScore = Number(row.away_score);
  const homeWin = homeScore > awayScore ? 1 : 0;
  const awayWin = awayScore > homeScore ? 1 : 0;
  const draw = homeScore === awayScore ? 1 : 0;
  observe(metric, 'moneyline_home', prediction.moneyline?.home?.rawProbability, homeWin);
  observe(metric, 'moneyline_away', prediction.moneyline?.away?.rawProbability, awayWin);
  if (prediction.moneyline?.draw) observe(metric, 'moneyline_draw', prediction.moneyline.draw.rawProbability, draw);
  const total = homeScore + awayScore;
  for (const [line, values] of Object.entries(prediction.totals?.lines || {})) {
    observe(metric, `total_over_${lineKey(line)}`, values.over?.rawProbability, total > Number(line) ? 1 : 0);
    observe(metric, `total_under_${lineKey(line)}`, values.under?.rawProbability, total < Number(line) ? 1 : 0);
  }
}

function finish(metric) {
  return {
    n: metric.n,
    brier: metric.n ? metric.squaredError / metric.n : null,
    validation: Object.fromEntries([...metric.recommendations.entries()].map(([key, value]) => [key, {
      n: value.n, hits: value.hits,
      hitRate: value.n ? value.hits / value.n : null,
      avgPred: value.n ? value.predicted / value.n : null,
    }])),
  };
}

async function evaluate(pool, sport, rows, historyByTeam, config, from, to) {
  const metric = emptyMetric();
  let errors = 0;
  for (let index = from; index < to; index++) {
    const row = rows[index];
    try {
      const fixture = fixtureFromRow(row);
      const prediction = await computeMultisportEmpiricalPrediction(pool, {
        sport, fixture, cutoff: new Date(row.kickoff), config,
        teamRows: {
          home: historyByTeam.get(String(row.home_team_id)) || [],
          away: historyByTeam.get(String(row.away_team_id)) || [],
        },
      });
      addPrediction(metric, prediction, row);
    } catch (error) {
      errors++;
      if (errors <= 3) console.error(`[train-${sport}] ${row.fixture_id}: ${error.message}`);
    }
  }
  return { ...finish(metric), errors };
}

async function activeConfig(pool, sport) {
  const { rows } = await pool.query(
    `SELECT version,weights,metrics FROM prediction_models
     WHERE sport=$1 AND market_key=$2 AND model_type='empirical-weighting' AND active=TRUE
     ORDER BY version DESC LIMIT 1`, [sport, MARKET_KEY]);
  return rows[0]
    ? { version: Number(rows[0].version), weights: normalizeMultisportEngineConfig(rows[0].weights), metrics: rows[0].metrics }
    : { version: 0, weights: normalizeMultisportEngineConfig(DEFAULT_MULTISPORT_ENGINE_CONFIG), metrics: null };
}

function score(metric) {
  return metric.brier == null ? Number.POSITIVE_INFINITY : metric.brier;
}

function sameWeights(left, right) {
  const a = normalizeMultisportEngineConfig(left);
  const b = normalizeMultisportEngineConfig(right);
  return Object.keys(a).every((key) => Number(a[key]) === Number(b[key]));
}

export async function trainMultisportEmpiricalEngine({ sport, pool: externalPool = null, limit = 500, dry = false } = {}) {
  const config = getMultisportConfig(sport);
  const ownPool = !externalPool;
  const pool = externalPool || new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 3,
  });
  try {
    const matchesTable = `${config.tablePrefix}_engine_matches`;
    const { rows } = await pool.query(
      `SELECT * FROM (
        SELECT * FROM ${matchesTable}
        WHERE finalized_at IS NOT NULL AND home_score IS NOT NULL AND away_score IS NOT NULL
        ORDER BY kickoff DESC LIMIT $1
      ) sample ORDER BY kickoff ASC`, [Number(limit)]);
    if (rows.length < 2) return { ok: true, sport: config.key, trained: false, reason: 'needs-two-chronological-games', sample: rows.length };
    const statsTable = `${config.tablePrefix}_engine_team_stats`;
    const teamIds = [...new Set(rows.flatMap((row) => [String(row.home_team_id), String(row.away_team_id)]))];
    const latestKickoff = rows.reduce((latest, row) => new Date(row.kickoff) > latest ? new Date(row.kickoff) : latest, new Date(0));
    const history = await pool.query(
      `SELECT * FROM ${statsTable} WHERE team_id=ANY($1::text[]) AND kickoff < $2 ORDER BY kickoff`,
      [teamIds, latestKickoff],
    );
    const historyByTeam = new Map();
    for (const fact of history.rows) {
      const id = String(fact.team_id);
      if (!historyByTeam.has(id)) historyByTeam.set(id, []);
      historyByTeam.get(id).push(fact);
    }
    const split = Math.max(1, Math.min(rows.length - 1, Math.floor(rows.length * 0.70)));
    const active = await activeConfig(pool, config.key);
    const trials = [];
    for (const candidate of [...GRID, active.weights]) {
      const weights = normalizeMultisportEngineConfig(candidate);
      const key = JSON.stringify(weights);
      if (trials.some((trial) => trial.key === key)) continue;
      const train = await evaluate(pool, config.key, rows, historyByTeam, weights, 0, split);
      trials.push({ key, weights, train });
    }
    trials.sort((left, right) => score(left.train) - score(right.train));
    const winner = trials[0];
    const [candidateValidation, baselineValidation] = await Promise.all([
      evaluate(pool, config.key, rows, historyByTeam, winner.weights, split, rows.length),
      evaluate(pool, config.key, rows, historyByTeam, active.weights, split, rows.length),
    ]);
    const configChanged = !sameWeights(winner.weights, active.weights);
    const candidateNotWorse = score(candidateValidation) <= score(baselineValidation) + 1e-12;
    const activates = active.version === 0 || (configChanged && candidateNotWorse);
    const servedWeights = activates ? winner.weights : active.weights;
    const servedValidation = activates ? candidateValidation : baselineValidation;
    const report = {
      processed: rows.length, historicalFacts: history.rows.length, train: split, holdout: rows.length - split,
      previousVersion: active.version, configChanged, candidateNotWorse, activates,
      candidate: { weights: winner.weights, train: winner.train, validation: candidateValidation },
      baseline: { weights: active.weights, validation: baselineValidation },
      validation: servedValidation.validation,
      trials: trials.map((trial) => ({ weights: trial.weights, brier: trial.train.brier, n: trial.train.n })),
    };
    if (dry) return { ok: true, sport: config.key, trained: true, dry: true, ...report };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (activates) {
        await client.query(
          `UPDATE prediction_models SET active=FALSE
           WHERE sport=$1 AND market_key=$2 AND model_type='empirical-weighting'`, [config.key, MARKET_KEY]);
        const { rows: versions } = await client.query(
          `SELECT COALESCE(MAX(version),0)::int+1 AS next FROM prediction_models WHERE sport=$1 AND market_key=$2`,
          [config.key, MARKET_KEY]);
        const version = Number(versions[0]?.next || 1);
        await client.query(
          `INSERT INTO prediction_models(sport,market_key,version,model_type,weights,metrics,active,trained_at)
           VALUES($1,$2,$3,'empirical-weighting',$4::jsonb,$5::jsonb,TRUE,now())`,
          [config.key, MARKET_KEY, version, JSON.stringify(servedWeights), JSON.stringify(report)]);
        report.version = version;
      } else {
        await client.query(
          `UPDATE prediction_models SET metrics=$1::jsonb,trained_at=now()
           WHERE sport=$2 AND market_key=$3 AND version=$4 AND active=TRUE`,
          [JSON.stringify(report), config.key, MARKET_KEY, active.version]);
        report.version = active.version;
      }
      await client.query(
        `DELETE FROM market_segment_diagnostics WHERE sport=$1 AND segment='validation-high'`,
        [config.key],
      );
      for (const [marketKey, diagnostic] of Object.entries(servedValidation.validation || {})) {
        await client.query(
          `INSERT INTO market_segment_diagnostics(sport,market_key,segment,sample_n,avg_pred,avg_actual,brier,calibration_error,updated_at)
           VALUES($1,$2,'validation-high',$3,$4,$5,NULL,$6,now())
           ON CONFLICT(sport,market_key,segment) DO UPDATE SET
             sample_n=EXCLUDED.sample_n,avg_pred=EXCLUDED.avg_pred,avg_actual=EXCLUDED.avg_actual,
             calibration_error=EXCLUDED.calibration_error,updated_at=now()`,
          [config.key, marketKey, diagnostic.n, diagnostic.avgPred, diagnostic.hitRate, Math.abs(diagnostic.avgPred - diagnostic.hitRate)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    resetMultisportEngineConfigCache(config.key);
    return { ok: true, sport: config.key, trained: true, ...report };
  } finally {
    if (ownPool) await pool.end();
  }
}

async function cli() {
  const sports = process.argv.includes('--all')
    ? ['baseball', 'basketball', 'american_football']
    : [process.argv.find((value) => ['baseball', 'basketball', 'american_football'].includes(value)) || 'baseball'];
  const dry = process.argv.includes('--dry');
  for (const sport of sports) console.log(JSON.stringify(await trainMultisportEmpiricalEngine({ sport, dry }), null, 2));
}

if (process.argv[1]?.endsWith('train-multisport-empirical-engine.js')) cli().catch((error) => { console.error(error); process.exit(1); });
