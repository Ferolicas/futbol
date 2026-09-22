const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/cfanalisis_test';
process.env.DATABASE_SSL ||= 'false';

const {
  MULTISPORT_CACHE_VERSION,
  selectGamesNeedingCurrentAnalysis,
  shouldRetryMissingBaseballOdds,
} = require('../lib/multisport-analysis.js');

test('minLeadMs corta el reintento de cuota si faltan menos de esa distancia al kickoff, sin importar la hora del cron', () => {
  const analysis = {
    fixture_id: 1,
    cache_version: MULTISPORT_CACHE_VERSION,
    updated_at: '2026-11-01T10:00:00Z',
    data_quality: { hasOdds: false },
  };
  const fourHoursOut = { id: 1, date: '2026-11-01T18:00:00Z', status: { short: 'NS' } };
  const now = new Date('2026-11-01T15:30:00Z'); // faltan 2h30 para el kickoff → menos de 4h

  assert.equal(shouldRetryMissingBaseballOdds(fourHoursOut, analysis, { now, minLeadMs: 4 * 3600_000 }), false);

  const sixHoursOut = { id: 1, date: '2026-11-01T21:30:00Z', status: { short: 'NS' } };
  assert.equal(shouldRetryMissingBaseballOdds(sixHoursOut, analysis, { now, minLeadMs: 4 * 3600_000 }), true);
});

test('sin minLeadMs (comportamiento previo de béisbol) el reintento no se corta por cercanía al kickoff', () => {
  const analysis = {
    fixture_id: 1,
    cache_version: MULTISPORT_CACHE_VERSION,
    updated_at: '2026-11-01T10:00:00Z',
    data_quality: { hasOdds: false },
  };
  const soonGame = { id: 1, date: '2026-11-01T16:00:00Z', status: { short: 'NS' } };
  const now = new Date('2026-11-01T15:30:00Z');
  assert.equal(shouldRetryMissingBaseballOdds(soonGame, analysis, { now }), true);
});

test('selectGamesNeedingCurrentAnalysis ya no restringe retryMissingOdds a béisbol', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/multisport-analysis.js'), 'utf8');
  assert.doesNotMatch(source, /retryMissingOdds:\s*config\.key === 'baseball'/);
  assert.match(source, /retryMissingOdds:\s*options\.retryMissingOdds === true/);
  assert.match(source, /minLeadMs:\s*options\.oddsRetryMinLeadMs/);
});

test('NFL tiene 3 pases de reintento de cuota en hora Colombia, con 4h de margen antes de cualquier kickoff', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../apps/cfanalisis-worker/src/schedulers.ts'),
    'utf8',
  );
  for (const hour of [6, 10, 14]) {
    const idPattern = new RegExp(`id: 'american-football-analyze-pregame-${String(hour).padStart(2, '0')}', pattern: '0 ${hour} \\* \\* \\*', tz: BOGOTA_TZ`);
    assert.match(source, idPattern, `falta el pase de las ${hour}:00 Bogotá`);
  }
  const matches = source.match(/onlyMissingCurrent: true, retryMissingOdds: true, oddsRetryMinLeadMs: 4 \* 3600_000/g) || [];
  assert.equal(matches.length, 3, 'los 3 pases deben exigir 4h de margen antes del kickoff');
});
