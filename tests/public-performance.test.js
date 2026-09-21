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

test('la API pública está paginada, cacheada, limitada y separada del admin', () => {
  const api = fs.readFileSync(path.join(__dirname, '../app/api/public/rendimiento/route.js'), 'utf8');
  const proof = fs.readFileSync(path.join(__dirname, '../app/api/verificar-pronostico/[id]/route.js'), 'utf8');
  const data = fs.readFileSync(path.join(__dirname, '../lib/public-performance.js'), 'utf8');
  assert.match(api, /pageSize.*max\(24\)/s);
  assert.match(api, /day.*week.*fortnight.*month.*quarter.*semester.*year.*custom/s);
  assert.match(api, /value\.from > value\.to/);
  assert.match(api, /public-performance:v1/);
  assert.match(api, /redisRateLimit\('public-performance'/);
  assert.match(api, /Cache-Control.*max-age=60/);
  assert.doesNotMatch(api, /getUserProfile|prediction-history/);
  assert.match(proof, /redisRateLimit\('public-proof'.*15.*60/s);
  assert.match(proof, /public-proof:v1/);
  assert.match(data, /r\.kickoff<now\(\)/);
  assert.match(data, /ps\.outcome IN \('won','lost','push','void'\)/);
  assert.doesNotMatch(data, /canonical_payload|response_tsr|model_version|feature_snapshot/);
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
