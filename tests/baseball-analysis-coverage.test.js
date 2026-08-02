const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/cfanalisis_test';
process.env.DATABASE_SSL ||= 'false';

const {
  MULTISPORT_CACHE_VERSION,
  buildSportAnalysisCoverageDates,
  selectGamesNeedingCurrentAnalysis,
} = require('../lib/multisport-analysis.js');
const {
  MAX_BASEBALL_ANALYSIS_FIXTURES,
  normalizeBaseballAnalysisFixtureIds,
} = require('../lib/baseball-analysis-request.js');

test('la cobertura incluye las fechas adyacentes incluso al cambiar de año', () => {
  assert.deepEqual(buildSportAnalysisCoverageDates('2026-01-01'), [
    '2025-12-31', '2026-01-01', '2026-01-02',
  ]);
});

test('solo reanaliza partidos inexistentes u obsoletos para el contrato vigente', () => {
  const games = [{ id: 1 }, { id: '2' }, { id: 3 }, { id: 4 }];
  const analyses = [
    { fixture_id: 1, cache_version: MULTISPORT_CACHE_VERSION },
    { fixture_id: 2, cache_version: MULTISPORT_CACHE_VERSION - 1 },
    { fixture_id: 4, cache_version: MULTISPORT_CACHE_VERSION + 1 },
  ];
  assert.deepEqual(
    selectGamesNeedingCurrentAnalysis(games, analyses).map((game) => String(game.id)),
    ['2', '3'],
  );
});

test('el endpoint admite jornadas grandes y nunca trunca silenciosamente a 50', () => {
  const fixtures = Array.from({ length: 400 }, (_, index) => ({ id: index + 1 }));
  const result = normalizeBaseballAnalysisFixtureIds(fixtures);
  assert.equal(result.tooMany, false);
  assert.equal(result.fixtureIds.length, 400);
  assert.equal(MAX_BASEBALL_ANALYSIS_FIXTURES, 500);
});

test('el límite defensivo de 500 devuelve una señal explícita', () => {
  const fixtures = Array.from({ length: 501 }, (_, index) => ({ id: index + 1 }));
  const result = normalizeBaseballAnalysisFixtureIds(fixtures);
  assert.equal(result.tooMany, true);
  assert.equal(result.total, 501);
  assert.equal(result.fixtureIds.length, 500);
});

test('la tarjeta pendiente abre estado automático y no ofrece analizar manualmente', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/baseball/page.js'), 'utf8');
  assert.match(source, /Preparando análisis automático/);
  assert.match(source, /Actualizando el análisis automáticamente/);
  assert.doesNotMatch(source, /Analizar \$\{selected\.size\}/);
  assert.doesNotMatch(source, /else onSelect\(game\.id\)/);
});
