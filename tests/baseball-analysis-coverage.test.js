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
  shouldRetryMissingBaseballOdds,
} = require('../lib/multisport-analysis.js');
const {
  MAX_BASEBALL_ANALYSIS_FIXTURES,
  normalizeBaseballAnalysisFixtureIds,
} = require('../lib/baseball-analysis-request.js');
const { getMultisportConfig } = require('../lib/multisport-config.js');
const { multisportProviderInternals } = require('../lib/multisport-providers.js');
const { MLB_SPORT_IDS } = require('../lib/mlb-stats-api.js');

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

test('después de las 10:30 Colombia reintenta solo juegos futuros sin cuotas', () => {
  const now = new Date('2026-08-03T15:45:00Z'); // 10:45 en Colombia
  const games = [
    { id: 1, date: '2026-08-03T22:40:00Z', status: { short: 'NS', isFinal: false, isLive: false } },
    { id: 2, date: '2026-08-03T23:05:00Z', status: { short: 'NS', isFinal: false, isLive: false } },
    { id: 3, date: '2026-08-03T23:40:00Z', status: { short: 'NS', isFinal: false, isLive: false } },
  ];
  const analyses = [
    {
      fixture_id: 1,
      cache_version: MULTISPORT_CACHE_VERSION,
      updated_at: '2026-08-03T15:25:00Z',
      data_quality: { hasOdds: false },
    },
    {
      fixture_id: 2,
      cache_version: MULTISPORT_CACHE_VERSION,
      updated_at: '2026-08-03T15:25:00Z',
      data_quality: { hasOdds: true },
    },
    {
      fixture_id: 3,
      cache_version: MULTISPORT_CACHE_VERSION,
      updated_at: '2026-08-03T15:40:00Z',
      data_quality: { hasOdds: false },
    },
  ];

  assert.deepEqual(
    selectGamesNeedingCurrentAnalysis(
      games,
      analyses,
      MULTISPORT_CACHE_VERSION,
      { retryMissingOdds: true, now },
    ).map((game) => String(game.id)),
    ['1'],
  );
});

test('no gasta cuota en reintentos antes de la hora tardía, otro día o un juego iniciado', () => {
  const analysis = {
    fixture_id: 1,
    cache_version: MULTISPORT_CACHE_VERSION,
    updated_at: '2026-08-03T13:00:00Z',
    data_quality: { hasOdds: false },
  };
  const futureToday = { id: 1, date: '2026-08-03T22:40:00Z', status: { short: 'NS' } };
  const tomorrow = { id: 1, date: '2026-08-04T22:40:00Z', status: { short: 'NS' } };
  const live = { id: 1, date: '2026-08-03T14:00:00Z', status: { short: 'LIVE', isLive: true } };

  assert.equal(shouldRetryMissingBaseballOdds(futureToday, analysis, {
    now: new Date('2026-08-03T14:59:00Z'), // 09:59 Colombia
  }), false);
  assert.equal(shouldRetryMissingBaseballOdds(tomorrow, analysis, {
    now: new Date('2026-08-03T15:45:00Z'),
  }), false);
  assert.equal(shouldRetryMissingBaseballOdds(live, analysis, {
    now: new Date('2026-08-03T15:45:00Z'),
  }), false);
});

test('los schedulers de MLB usan el pase tardío y el prepartido en hora Colombia', () => {
  const source = fs.readFileSync(path.join(__dirname, '../apps/cfanalisis-worker/src/schedulers.ts'), 'utf8');
  assert.match(source, /const BOGOTA_TZ = 'America\/Bogota'/);
  assert.match(source, /id: 'baseball-analyze-daily', pattern: '30 10 \* \* \*', tz: BOGOTA_TZ/);
  assert.match(source, /id: 'baseball-analyze-pregame', pattern: '0 12,14,16,18,20,22 \* \* \*', tz: BOGOTA_TZ/);
  assert.match(source, /id: 'baseball-retrain-daily',\s+pattern: '40 10 \* \* \*', tz: TZ/);
});

test('la guardia limita cada fecha y solo considera críticas hoy y mañana', () => {
  const source = fs.readFileSync(path.join(__dirname, '../apps/cfanalisis-worker/src/jobs/baseball/analyze.js'), 'utf8');
  assert.match(source, /dateTimeoutMs: 3 \* 60_000/);
  assert.match(source, /targetDates\.filter\(\(date\) => date >= today\)/);
  assert.match(source, /ok: criticalFailed === 0/);
});

test('el mapeo de cuotas conserva en Colombia los juegos que cruzan medianoche UTC', () => {
  assert.equal(
    multisportProviderInternals.providerDateForGame('baseball', '2026-08-04T00:05:00Z'),
    '2026-08-03',
  );
  assert.equal(
    multisportProviderInternals.providerDateForGame('basketball', '2026-08-04T00:05:00Z'),
    '2026-08-04',
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
  assert.match(source, /role="LOCAL" winProbability=\{winProbabilities\?\.home\}/);
  assert.match(source, /role="VISITANTE" winProbability=\{winProbabilities\?\.away\}/);
});

test('todos los consumidores operativos de Baseball solicitan exclusivamente MLB', () => {
  assert.deepEqual(getMultisportConfig('baseball').competitions.map((competition) => competition.id), ['1']);
  assert.deepEqual(Object.keys(MLB_SPORT_IDS), ['1']);

  const leaguesRoute = fs.readFileSync(path.join(__dirname, '../app/api/baseball/leagues/route.js'), 'utf8');
  assert.doesNotMatch(leaguesRoute, /id:\s*(11|12|13|14|16)\b/);
});

test('la lista de partidos no transporta el análisis pesado de jugadores y entradas', () => {
  const route = fs.readFileSync(path.join(__dirname, '../app/api/baseball/fixtures/route.js'), 'utf8');
  assert.doesNotMatch(route, /select\('fixture_id, probabilities,/);
  assert.match(route, /best_odds: \{ moneyline:/);
  assert.match(route, /analysis:\s*\{\s*\n\s*pitcherMatchup:/);
  assert.match(route, /finalVerdict: analysis\.analysis\?\.finalVerdict \|\| null/);
  assert.doesNotMatch(route, /playerMarkets: analysis\.analysis/);
  assert.match(route, /innings, home_stats, away_stats, finished_at/);
});

test('el live de MLB cierra resultados y cubre la jornada anterior', () => {
  const source = fs.readFileSync(path.join(__dirname, '../apps/cfanalisis-worker/src/jobs/baseball/live.js'), 'utf8');
  assert.match(source, /\[addDays\(today, -1\), today\]/);
  assert.match(source, /buildBaseballResultRow/);
  assert.match(source, /home_stats,away_stats,finished_at/);
  assert.doesNotMatch(source, /reason: 'no live games'/);
});

test('la interfaz prioriza Final oficial y muestra el boxscore MLB', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '../app/dashboard/baseball/page.js'), 'utf8');
  const resultStats = fs.readFileSync(path.join(__dirname, '../app/dashboard/baseball/components/BaseballResultStats.js'), 'utf8');
  assert.match(dashboard, /const effectiveGameStatus/);
  assert.match(dashboard, /isFinished\(game\?\.status\?\.short\)/);
  assert.match(dashboard, /<BaseballResultStats/);
  assert.match(resultStats, /short: 'HR'/);
  assert.match(resultStats, /short: 'RBI'/);
  assert.match(resultStats, /CARRERAS POR ENTRADA/);
});
