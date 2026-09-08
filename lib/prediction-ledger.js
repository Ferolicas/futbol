import crypto from 'node:crypto';
import { pgPool } from './db.js';
import predictionMath from './prediction-math.cjs';
import { settleMarketSelection } from './market-settlement.js';
import footballResultSnapshot from './football-result-snapshot.cjs';

const { strictPregameCutoff } = predictionMath;
const { buildDurableResultSnapshot } = footballResultSnapshot;

function canonical(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function predictionPayloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function footballHorizon(analysis) {
  if (analysis?.predictionMeta?.horizon) return analysis.predictionMeta.horizon;
  if (analysis?.lineups?.available || analysis?.hasLineup) return 'confirmed-lineup';
  return 'early';
}

function marketFamily(key, row) {
  return row?.validation?.family || row?.category || String(key || '').replace(/_(?:over|under).*$/, '');
}

function recommendationById(analysis) {
  const items = analysis?.combinada?.selectable || analysis?.combinada?.selections || [];
  return new Map(items.map((item) => [String(item.id), item]));
}

function footballOutputs(analysis) {
  const recommendations = recommendationById(analysis);
  const teamOutputs = Object.entries(analysis?._scored || {}).map(([key, row]) => {
    const recommendation = recommendations.get(String(key));
    return {
      key,
      family: marketFamily(key, row),
      raw: Number.isFinite(Number(row?.prob_raw)) ? Number(row.prob_raw) : null,
      calibrated: Number.isFinite(Number(row?.prob_calibrated ?? row?.prob_final)) ? Number(row.prob_calibrated ?? row.prob_final) : null,
      confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : null,
      sampleN: Number.isFinite(Number(row?.n)) ? Number(row.n) : null,
      validationStatus: row?.validation?.decision?.status || recommendation?.validationStatus || 'unvalidated',
      validation: row?.validation || {},
      odd: Number.isFinite(Number(recommendation?.odd)) ? Number(recommendation.odd) : null,
      bookmaker: recommendation?.bookmaker || null,
      marketFairProbability: Number.isFinite(Number(recommendation?.marketFairProbability)) ? Number(recommendation.marketFairProbability) : null,
      expectedValue: Number.isFinite(Number(recommendation?.expectedValue)) ? Number(recommendation.expectedValue) : null,
      recommended: !!recommendation,
      rejectionReasons: recommendation ? [] : (row?.validation?.decision?.status ? [row.validation.decision.status] : ['not-published']),
      output: row || {},
    };
  });
  const playerOutputs = [];
  const pushPlayer = (player, category, market, line = null) => {
    const probability = Number(market?.prob);
    if (!Number.isFinite(probability)) return;
    const id = `${category}-${player.player_id}${line == null ? '' : `-${line}`}`;
    const recommendation = recommendations.get(id);
    const family = market?.validation?.family
      || (line == null
        ? `player_${category}`
        : `player_${category}_over_${String(line).replace('-', 'm').replace('.', '_')}`);
    playerOutputs.push({
      key: id,
      family,
      raw: probability,
      calibrated: Number.isFinite(Number(recommendation?.rawProbability))
        ? Number(recommendation.rawProbability) / 100
        : probability,
      confidence: Number.isFinite(Number(market?.conf)) ? Number(market.conf) : null,
      sampleN: Number.isFinite(Number(market?.n)) ? Number(market.n) : null,
      validationStatus: market?.validation?.available
        ? (market.validation?.decision?.status || 'pending-assessment')
        : 'unvalidated',
      validation: market?.validation || {},
      odd: Number.isFinite(Number(recommendation?.odd)) ? Number(recommendation.odd) : null,
      bookmaker: recommendation?.bookmaker || null,
      marketFairProbability: null,
      expectedValue: Number.isFinite(Number(recommendation?.expectedValue)) ? Number(recommendation.expectedValue) : null,
      recommended: !!recommendation,
      rejectionReasons: recommendation ? [] : ['not-published'],
      output: {
        id,
        category: `${category}-${player.player_id}`,
        scope: 'player',
        playerId: Number(player.player_id),
        playerName: player.name || null,
        probability: probability * 100,
        rawProbability: probability * 100,
        _line: line == null ? undefined : Number(line),
      },
    });
  };
  for (const player of Object.values(analysis?.playerMarkets || {})) {
    const markets = player?.markets || {};
    pushPlayer(player, 'scorer', markets.anytime_scorer);
    pushPlayer(player, 'booked', markets.to_be_carded);
    for (const line of markets.shots?.lines || []) pushPlayer(player, 'shotsTotal', line, line.line);
    for (const line of markets.shots_on?.lines || []) pushPlayer(player, 'shotsOn', line, line.line);
    for (const line of markets.fouls?.lines || []) pushPlayer(player, 'fouls', line, line.line);
  }
  return [...teamOutputs, ...playerOutputs];
}

function multisportOutputs(payload, auditedMarkets = null) {
  const rows = Array.isArray(auditedMarkets)
    ? auditedMarkets
    : (payload?.combinada?.selectable || payload?.combinada?.selections || []);
  return rows.map((row) => ({
    key: String(row.id), family: row.validationKey || row.category || null,
    raw: Number.isFinite(Number(row.empiricalProbability)) ? Number(row.empiricalProbability) / 100 : null,
    calibrated: Number.isFinite(Number(row.rawProbability)) ? Number(row.rawProbability) / 100 : null,
    confidence: Number.isFinite(Number(row.reliability ?? row.confidence)) ? Number(row.reliability ?? row.confidence) / 100 : null,
    sampleN: Number.isFinite(Number(row.sampleN)) ? Number(row.sampleN) : null,
    validationStatus: row.validationStatus || 'unvalidated', validation: row.validation || {},
    odd: Number.isFinite(Number(row.odd)) ? Number(row.odd) : null,
    bookmaker: row.bookmaker || null,
    marketFairProbability: Number.isFinite(Number(row.marketFairProbability)) ? Number(row.marketFairProbability) : null,
    expectedValue: Number.isFinite(Number(row.expectedValue)) ? Number(row.expectedValue) : null,
    recommended: row.statisticalRecommendation !== false,
    rejectionReasons: Array.isArray(row.rejectionReasons) ? row.rejectionReasons : [],
    output: row,
  }));
}

export async function recordPredictionRun(input, pool = pgPool) {
  const sport = String(input?.sport || 'football');
  const fixtureId = String(input?.fixtureId || '');
  const analysis = input?.analysis || input?.payload?.analysis || input?.payload || {};
  const kickoff = iso(input?.kickoff || analysis.kickoff || input?.game?.date);
  if (!fixtureId || !kickoff) return { skipped: 'missing-identity' };

  const kickoffDate = new Date(kickoff);
  const meta = analysis.predictionMeta || input?.predictionMeta || {};
  const predictedAt = iso(meta.predictedAt || input?.predictedAt || analysis.fetchedAt || new Date());
  if (!predictedAt || new Date(predictedAt) >= kickoffDate) return { skipped: 'not-pregame' };
  const dataCutoff = iso(meta.dataCutoff || input?.dataCutoff || strictPregameCutoff(kickoffDate, predictedAt));
  const horizon = sport === 'football'
    ? footballHorizon(analysis)
    : (meta.horizon || input?.horizon || 'early');
  const outputs = sport === 'football'
    ? footballOutputs(analysis)
    : multisportOutputs(input?.payload || analysis, input?.marketOutputs);
  const recommendations = input?.payload?.combinada?.selectable
    || analysis?.combinada?.selectable
    || analysis?.combinada?.selections
    || [];
  const snapshot = {
    sport, fixtureId, horizon, predictedAt, kickoff, dataCutoff,
    modelVersion: meta.modelVersion || input?.modelVersion || null,
    features: meta.features || input?.features || {},
    probabilities: input?.payload?.probabilities || analysis.calculatedProbabilities || input?.probabilities || {},
    recommendations,
    odds: input?.payload?.odds || analysis.odds || input?.odds || {},
  };
  const payloadHash = predictionPayloadHash(snapshot);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `WITH inserted AS (
       INSERT INTO prediction_runs(
         sport,fixture_id,horizon,predicted_at,kickoff,data_cutoff,model_version,
         analysis_version,data_quality,payload_hash,feature_snapshot,probabilities,
         recommendations,odds_snapshot,metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb)
       ON CONFLICT(sport,fixture_id,horizon,payload_hash) DO NOTHING
       RETURNING id
       )
       SELECT id FROM inserted
       UNION ALL
       SELECT id FROM prediction_runs
       WHERE sport=$1 AND fixture_id=$2 AND horizon=$3 AND payload_hash=$10
       LIMIT 1`,
      [sport, fixtureId, horizon, predictedAt, kickoff, dataCutoff,
        String(snapshot.modelVersion || ''), Number(input?.analysisVersion || analysis.cacheVersion || 0),
        JSON.stringify(input?.dataQuality ?? analysis.dataQuality ?? null), payloadHash,
        JSON.stringify(snapshot.features), JSON.stringify(snapshot.probabilities),
        JSON.stringify(recommendations), JSON.stringify(snapshot.odds),
        JSON.stringify({ source: input?.source || 'analysis-cache', engine: meta.engine || null })],
    );
    const runId = Number(inserted.rows[0].id);
    for (const output of outputs) {
      await client.query(
        `INSERT INTO prediction_market_outputs(
           run_id,market_key,market_family,probability_raw,probability_calibrated,
           confidence,sample_n,validation_status,validation_snapshot,offered_odd,
           bookmaker,market_fair_probability,expected_value,is_recommendation,
           rejection_reasons,output
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)
         ON CONFLICT(run_id,market_key) DO NOTHING`,
        [runId, output.key, output.family, output.raw, output.calibrated,
          output.confidence, output.sampleN, output.validationStatus,
          JSON.stringify(output.validation), output.odd, output.bookmaker,
          output.marketFairProbability, output.expectedValue, output.recommended,
          JSON.stringify(output.rejectionReasons), JSON.stringify(output.output)],
      );
    }
    await client.query('COMMIT');
    return { runId, payloadHash, markets: outputs.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function appendPredictionSettlements({ sport, fixtureId, result, settlements }, pool = pgPool) {
  const runs = await pool.query(
    `SELECT id FROM prediction_runs WHERE sport=$1 AND fixture_id=$2`,
    [String(sport), String(fixtureId)],
  );
  let written = 0;
  for (const run of runs.rows) {
    for (const settlement of settlements || []) {
      const resultSnapshot = { result: result || {}, settlement };
      const resultHash = predictionPayloadHash(resultSnapshot);
      const response = await pool.query(
        `INSERT INTO prediction_settlements(run_id,market_key,outcome,result_snapshot,result_hash)
         VALUES($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT(run_id,market_key,result_hash) DO NOTHING`,
        [run.id, String(settlement.marketKey), settlement.outcome || 'unsettled', JSON.stringify(resultSnapshot), resultHash],
      );
      written += response.rowCount || 0;
    }
  }
  return { runs: runs.rowCount, written };
}

export async function settlePredictionFixture({ sport, fixtureId, game, liveResult }, pool = pgPool) {
  const { rows } = await pool.query(
    `SELECT r.id AS run_id,o.market_key,o.output
     FROM prediction_runs r
     JOIN prediction_market_outputs o ON o.run_id=r.id
     WHERE r.sport=$1 AND r.fixture_id=$2`,
    [String(sport), String(fixtureId)],
  );
  let written = 0;
  for (const row of rows) {
    const state = settleMarketSelection({
      sport,
      selection: { ...(row.output || {}), id: row.market_key },
      game,
      liveResult,
    });
    if (!state?.settled) continue;
    const outcome = state.status === 'void' ? 'void' : state.status;
    const snapshot = { game, liveResult, observed: state.observed };
    const resultHash = predictionPayloadHash(snapshot);
    const result = await pool.query(
      `INSERT INTO prediction_settlements(run_id,market_key,outcome,result_snapshot,result_hash)
       VALUES($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT(run_id,market_key,result_hash) DO NOTHING`,
      [row.run_id, row.market_key, outcome, JSON.stringify(snapshot), resultHash],
    );
    written += result.rowCount || 0;
  }
  return { outputs: rows.length, written };
}

export async function reconcileFootballPredictionSettlements(fixtureIds, pool = pgPool) {
  const ids = [...new Set((fixtureIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return { fixtures: 0, written: 0 };
  const { rows } = await pool.query(
    `SELECT * FROM match_results WHERE fixture_id=ANY($1::bigint[])`, [ids],
  );
  let written = 0;
  for (const row of rows) {
    const liveResult = buildDurableResultSnapshot(row);
    if (!liveResult) continue;
    const playerFacts = await pool.query(
      `SELECT player_id,goals,shots_total,shots_on,yellow,red,fouls_committed
       FROM model.player_match_stats WHERE fixture_id=$1`,
      [Number(row.fixture_id)],
    ).catch(() => ({ rows: [] }));
    liveResult.player_stats = Object.fromEntries(playerFacts.rows.map((fact) => [String(fact.player_id), {
      stats: {
        goals: fact.goals,
        shots_total: fact.shots_total,
        shots_on: fact.shots_on,
        yellow: fact.yellow,
        red: fact.red,
        fouls_committed: fact.fouls_committed,
      },
    }]));
    const result = await settlePredictionFixture({
      sport: 'football', fixtureId: row.fixture_id,
      game: row.full_data || null, liveResult,
    }, pool);
    written += result.written;
  }
  return { fixtures: rows.length, written };
}

function emptyCalibrationBucket() {
  return { n: 0, predicted: 0, hits: 0, brier: 0, logLoss: 0 };
}

function addCalibrationObservation(bucket, probability, outcome) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p < 0 || p > 1 || !['won', 'lost'].includes(outcome)) return;
  const hit = outcome === 'won' ? 1 : 0;
  const safe = Math.max(1e-12, Math.min(1 - 1e-12, p));
  bucket.n++;
  bucket.predicted += p;
  bucket.hits += hit;
  bucket.brier += (p - hit) ** 2;
  bucket.logLoss += -(hit * Math.log(safe) + (1 - hit) * Math.log(1 - safe));
}

function finishCalibrationBucket(bucket) {
  if (!bucket?.n) return { n: 0 };
  return {
    n: bucket.n,
    avg_pred: bucket.predicted / bucket.n,
    avg_actual: bucket.hits / bucket.n,
    hitRate: bucket.hits / bucket.n,
    brier: bucket.brier / bucket.n,
    logloss: bucket.logLoss / bucket.n,
    gap: Math.abs(bucket.predicted - bucket.hits) / bucket.n,
  };
}

function aggregateLedgerCalibration(rows) {
  const groups = new Map();
  const bucketFor = (family, horizon) => {
    const key = `${horizon}\u0000${family}`;
    if (!groups.has(key)) groups.set(key, {
      family, horizon,
      all: emptyCalibrationBucket(), selectable70: emptyCalibrationBucket(), high: emptyCalibrationBucket(),
      daily90: emptyCalibrationBucket(), elite95: emptyCalibrationBucket(),
    });
    return groups.get(key);
  };
  for (const row of rows || []) {
    const family = String(row.market_family || '').trim();
    const horizon = String(row.horizon || 'early');
    // El ledger valida exactamente la cifra que vio el usuario. La frecuencia
    // cruda queda trazada, pero no debe sustituir a la probabilidad calibrada.
    const probability = Number(row.probability_calibrated ?? row.probability_raw);
    if (!family || !Number.isFinite(probability)) continue;
    const group = bucketFor(family, horizon);
    addCalibrationObservation(group.all, probability, row.outcome);
    if (probability >= 0.70) addCalibrationObservation(group.selectable70, probability, row.outcome);
    if (probability >= 0.80) addCalibrationObservation(group.high, probability, row.outcome);
    if (probability >= 0.90) addCalibrationObservation(group.daily90, probability, row.outcome);
    if (probability >= 0.95) addCalibrationObservation(group.elite95, probability, row.outcome);
  }
  return [...groups.values()].filter((group) => group.all.n > 0).map((group) => ({
    family: group.family,
    horizon: group.horizon,
    ...finishCalibrationBucket(group.all),
    selectable70: finishCalibrationBucket(group.selectable70),
    high: finishCalibrationBucket(group.high),
    daily90: finishCalibrationBucket(group.daily90),
    elite95: finishCalibrationBucket(group.elite95),
  }));
}

function mergeEligible(existing, incoming, minimumSample) {
  const output = { ...(existing || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (Number(value?.n || 0) >= minimumSample) output[key] = value;
  }
  return output;
}

/**
 * Renueva la calibración con pronósticos realmente publicados/registrados,
 * nunca reconstruidos después del resultado. Hasta alcanzar `minimumSample`
 * conserva el holdout walk-forward existente; una muestra corta no desplaza
 * una validación madura.
 */
export async function refreshPredictionLedgerCalibration(sport, pool = pgPool, options = {}) {
  const minimumSample = Math.max(30, Number(options.minimumSample) || 30);
  const settled = await pool.query(
    `SELECT r.horizon,o.market_family,o.probability_raw,o.probability_calibrated,s.outcome
     FROM prediction_runs r
     JOIN prediction_market_outputs o ON o.run_id=r.id
     JOIN LATERAL (
       SELECT outcome FROM prediction_settlements ps
       WHERE ps.run_id=o.run_id AND ps.market_key=o.market_key
         AND ps.outcome IN ('won','lost')
       ORDER BY ps.settled_at DESC,ps.id DESC LIMIT 1
     ) s ON TRUE
     WHERE r.sport=$1 AND r.predicted_at<r.kickoff`,
    [String(sport)],
  );
  const groups = aggregateLedgerCalibration(settled.rows);
  const active = await pool.query(
    `SELECT version,metrics FROM prediction_models
     WHERE sport=$1 AND market_key='__empirical_engine__'
       AND model_type='empirical-weighting' AND active=TRUE
     ORDER BY version DESC LIMIT 1`,
    [String(sport)],
  );
  if (!active.rows[0]) return { sport, observations: settled.rowCount, updated: false, reason: 'no-active-model' };

  const metrics = structuredClone(active.rows[0].metrics || {});
  const eligible = groups.filter((group) => Number(group.n) >= minimumSample);
  if (sport === 'football') {
    const horizons = {};
    for (const group of eligible) {
      const key = group.horizon === 'confirmed-lineup' ? 'confirmed'
        : group.horizon === 'probable-lineup' ? 'probable' : 'early';
      horizons[key] ||= {};
      horizons[key][group.family] = group;
    }
    metrics.candidate ||= {};
    metrics.candidate.horizons ||= {};
    for (const [horizon, families] of Object.entries(horizons)) {
      metrics.candidate.horizons[horizon] ||= {};
      metrics.candidate.horizons[horizon].families = mergeEligible(
        metrics.candidate.horizons[horizon].families,
        families,
        minimumSample,
      );
    }
  } else {
    const validation = {};
    // Multideporte sirve una calibración por familia exacta para el rango que
    // puede recomendarse (>=65%); los buckets superiores quedan en el ledger.
    for (const group of eligible) validation[group.family] = {
      n: group.n, hits: Math.round(group.avg_actual * group.n),
      hitRate: group.avg_actual, avgPred: group.avg_pred,
      brier: group.brier, logloss: group.logloss,
    };
    metrics.validation = mergeEligible(metrics.validation, validation, minimumSample);
  }
  metrics.ledgerCalibration = {
    refreshedAt: new Date().toISOString(),
    observations: settled.rowCount,
    eligibleFamilies: eligible.length,
    minimumSample,
  };
  await pool.query(
    `UPDATE prediction_models SET metrics=$1::jsonb,trained_at=now()
     WHERE sport=$2 AND market_key='__empirical_engine__' AND version=$3 AND active=TRUE`,
    [JSON.stringify(metrics), String(sport), Number(active.rows[0].version)],
  );
  return { sport, observations: settled.rowCount, updated: true, eligibleFamilies: eligible.length };
}

export const predictionLedgerInternals = {
  canonical,
  footballOutputs,
  multisportOutputs,
  aggregateLedgerCalibration,
  mergeEligible,
};
