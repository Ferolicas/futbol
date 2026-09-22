const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/cfanalisis_test';
process.env.DATABASE_SSL ||= 'false';

test('el histórico general incluye archivo previo, ranking por mercado y lista sólo de sellos finalizados', async () => {
  const { summarizePublicPerformance } = await import('../lib/public-performance.js');
  const seal = { status: 'sealed', publicId: '11111111-1111-4111-8111-111111111111', provider: 'FreeTSA', sealedAt: '2026-09-20T10:00:00Z' };
  const base = { sport: 'football', league: 'Liga', homeTeam: 'Local', awayTeam: 'Visitante', marketName: 'Más de 1.5', probability: 70, odd: 1.5 };
  const result = summarizePublicPerformance([
    { ...base, kickoff: '2026-05-14T10:00:00Z', outcome: 'won', certified: false },
    { ...base, kickoff: '2026-05-15T10:00:00Z', outcome: 'lost', certified: false },
    { ...base, kickoff: '2026-09-20T12:00:00Z', outcome: 'won', certified: true, seal },
    { ...base, kickoff: '2026-09-20T14:00:00Z', outcome: 'pending', certified: true, seal },
  ], { page: 1, pageSize: 12 });
  assert.deepEqual(result.totals, { won: 2, lost: 1, neutral: 0, total: 3, accuracy: 66.67 });
  assert.equal(result.periods.archive.total, 2);
  assert.equal(result.periods.archive.retroactivelySealed, false);
  assert.equal(result.periods.certified.total, 1);
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].seal.publicId, seal.publicId);
  assert.deepEqual(result.marketPerformance.map(({ marketName, won, lost, accuracy }) => ({ marketName, won, lost, accuracy })), [
    { marketName: 'Más de 1.5', won: 2, lost: 1, accuracy: 66.67 },
  ]);
});

test('canonicalMarketName agrupa por mercado quitando el equipo, no la línea o el periodo', async () => {
  const { canonicalMarketName } = await import('../lib/public-performance.js');
  assert.equal(canonicalMarketName('St. Louis Cardinals: más de 4.5 carreras', 'St. Louis Cardinals', 'Cubs'), 'más de 4.5 carreras');
  assert.equal(canonicalMarketName('Ajax · 1ª Parte — Córners a favor — Más de 4.5', 'Ajax', 'PSV'), '1ª Parte — Córners a favor — Más de 4.5');
  assert.equal(canonicalMarketName('Ganador — Ajax', 'Ajax', 'PSV'), 'Ganador');
  assert.equal(canonicalMarketName('Más de 1.5', 'Local', 'Visitante'), 'Más de 1.5');
});

test('buildMarketPerformance agrupa el mismo mercado entre distintos equipos', async () => {
  const { buildMarketPerformance } = await import('../lib/public-performance.js');
  const rows = [
    { sport: 'baseball', outcome: 'won', homeTeam: 'St. Louis Cardinals', awayTeam: 'Cubs', marketName: 'St. Louis Cardinals: más de 4.5 carreras' },
    { sport: 'baseball', outcome: 'lost', homeTeam: 'Yankees', awayTeam: 'Red Sox', marketName: 'Yankees: más de 4.5 carreras' },
  ];
  const result = buildMarketPerformance(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].marketName, 'más de 4.5 carreras');
  assert.equal(result[0].won, 1);
  assert.equal(result[0].lost, 1);
});

test('getPublicPerformance nunca reporta desde antes de la versión vigente del motor', async () => {
  const { getPublicPerformance, ENGINE_VERSION_SINCE } = await import('../lib/public-performance.js');
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('min(kickoff)')) return { rows: [{ kickoff: null }] };
      return { rows: [] };
    },
  };
  const result = await getPublicPerformance({ from: '2025-01-01', to: null, sport: null, query: '', league: '', market: '', team: '', page: 1, pageSize: 12 }, pool);
  assert.equal(result.engineSince, ENGINE_VERSION_SINCE);
  const ledgerCall = calls.find((call) => call.sql.includes('prediction_runs r'));
  assert.equal(ledgerCall.params[0], ENGINE_VERSION_SINCE);
});

test('la API pública está paginada, cacheada, limitada y separada del admin', () => {
  const api = fs.readFileSync(path.join(__dirname, '../app/api/public/rendimiento/route.js'), 'utf8');
  const proof = fs.readFileSync(path.join(__dirname, '../app/api/verificar-pronostico/[id]/route.js'), 'utf8');
  const data = fs.readFileSync(path.join(__dirname, '../lib/public-performance.js'), 'utf8');
  assert.match(api, /pageSize.*max\(24\)/s);
  assert.match(api, /day.*week.*fortnight.*month.*quarter.*semester.*year.*custom/s);
  assert.match(api, /value\.from > value\.to/);
  assert.match(api, /public-performance:v2/);
  assert.match(api, /redisRateLimit\('public-performance'/);
  assert.match(api, /Cache-Control.*max-age=60/);
  assert.doesNotMatch(api, /getUserProfile|prediction-history/);
  assert.match(proof, /redisRateLimit\('public-proof'.*15.*60/s);
  assert.match(proof, /public-proof:v1/);
  assert.match(data, /r\.kickoff<now\(\)/);
  assert.match(data, /ps\.outcome IN \('won','lost','push','void'\)/);
  assert.doesNotMatch(data, /canonical_payload|response_tsr|model_version|feature_snapshot/);
});

test('el histórico multisport sólo incorpora picks Bet365 prepartido y los liquida con resultado oficial', async () => {
  const { loadLegacyMultisportRows } = await import('../lib/public-performance.js');
  const queries = [];
  const pool = { query: async (sql) => {
    queries.push(sql);
    if (!sql.includes('baseball_match_analysis')) return { rows: [] };
    return { rows: [{
      fixture_id: '777', start_time: '2026-08-10T20:00:00Z', league_name: 'MLB',
      home_team: 'Home', away_team: 'Away', home_score: 6, away_score: 4,
      periods: { home: [1, 0, 2, 0, 1, 0, 0, 2, 0], away: [0, 1, 0, 1, 0, 0, 2, 0, 0] },
      actual: { home: 6, away: 4 },
      selection: { id: 'total-8.5-over', name: 'Más de 8.5 carreras', line: 8.5, side: 'over', odd: 1.8, bookmaker: 'Bet365', statisticalRecommendation: true },
    }] };
  } };
  const rows = await loadLegacyMultisportRows({ sport: 'baseball' }, '2026-09-08T00:00:00Z', pool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sport, 'baseball');
  assert.equal(rows[0].outcome, 'won');
  assert.equal(rows[0].certified, false);
  assert.match(queries[0], /a\.created_at<a\.start_time/);
  assert.match(queries[0], /bet365/);
  assert.match(queries[0], /finalized_at IS NOT NULL/);
});

test('la presentación diferencia expresamente el archivo no sellado', () => {
  const page = fs.readFileSync(path.join(__dirname, '../app/rendimiento/PublicPerformance.js'), 'utf8');
  assert.match(page, /No se presentan como selladas retroactivamente/);
  assert.match(page, /exclusivamente recomendaciones con partido finalizado y sello FreeTSA/);
  assert.match(page, /PredictionSealBadge/);
  assert.match(page, /Rango personalizado/);
  assert.match(page, /type="date"/);
  assert.match(page, /Mercados ganadores y perdedores/);
});
