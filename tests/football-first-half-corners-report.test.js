const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/cfanalisis_test';
process.env.DATABASE_SSL ||= 'false';

test('calcula la expectativa con promedios 2026 y conserva solo los últimos cinco reales', async () => {
  const {
    assembleFootballFirstHalfCornerMatches,
    buildTeamFirstHalfCornerProfile,
    expectedFirstHalfCorners,
  } = await import('../lib/football-first-half-corners-report.js');
  const rows = [6, 5, 4, 3, 2, 1].map((corners, index) => ({
    fixture_id: 100 + index,
    kickoff: `2026-08-${String(20 - index).padStart(2, '0')}T20:00:00Z`,
    corners_1h: corners,
    opponent_name: `Rival ${index}`,
    competition_name: 'Liga',
    is_home: index % 2 === 0,
  }));
  rows.push({ fixture_id: 999, kickoff: '2026-08-21T20:00:00Z', corners_1h: null });
  const profile = buildTeamFirstHalfCornerProfile(rows, '2026-08-25T20:00:00Z');
  assert.equal(profile.sample, 6);
  assert.equal(profile.average, 3.5);
  assert.deepEqual(profile.recent.map((match) => match.corners), [6, 5, 4, 3, 2]);
  assert.equal(expectedFirstHalfCorners(profile, { average: 2.2 }), 5.7);
  assert.equal(expectedFirstHalfCorners(profile, { average: null }), null);

  const fixtures = [{
    fixture_id: 7,
    kickoff: '2026-08-25T20:00:00Z',
    status: 'NS',
    home_team_id: 1,
    away_team_id: 2,
    home_team_name: 'Fiorentina',
    away_team_name: 'Inter',
    competition_name: 'Serie A',
  }];
  const matches = assembleFootballFirstHalfCornerMatches(fixtures, new Map([
    [1, rows],
    [2, [{ fixture_id: 50, kickoff: '2026-08-10T20:00:00Z', corners_1h: 2 }]],
  ]));
  assert.equal(matches[0].expectedCorners, 5.5);
  assert.equal(matches[0].home.recent.length, 5);
  assert.equal(matches[0].away.sample, 1);
});

test('el CSV de fútbol contiene únicamente el resumen de córners de primera parte', async () => {
  const { renderFootballFirstHalfCornersCsv } = await import('../lib/football-first-half-corners-report.js');
  const content = renderFootballFirstHalfCornersCsv([{
    time: '16:30', league: 'Serie A', expectedCorners: 4.7,
    home: { name: 'Fiorentina', average: 2.4, sample: 5, recent: [] },
    away: { name: 'Inter', average: 2.3, sample: 5, recent: [] },
  }]);
  assert.match(content, /Córners esperados 1\.ª parte/);
  assert.match(content, /Fiorentina vs Inter/);
  assert.doesNotMatch(content, /Probabilidad|Fiabilidad|Goles|Tarjetas|Hándicap/);
});

test('el endpoint cron sigue siendo privado y entrega el nuevo CSV', () => {
  const route = fs.readFileSync(
    path.join(__dirname, '../app/api/cron/personal-market-report/route.js'),
    'utf8',
  );
  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /buildFootballFirstHalfCornersReport/);
  assert.match(route, /Content-Disposition/);
  assert.match(route, /text\/csv/);
  assert.doesNotMatch(route, /buildFootballPersonalMarketReport/);
});
