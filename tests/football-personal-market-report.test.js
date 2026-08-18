const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('genera las 60 líneas pedidas por cada partido sin aplicar umbrales', async () => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';
  const {
    buildFootballPersonalMarketRows,
    renderFootballPersonalMarketCsv,
  } = await import('../lib/football-market-report.js');
  const analyses = [{
    fixture_id: 123,
    analysis: {
      homeTeam: 'Local', awayTeam: 'Visitante', league: 'Liga',
      kickoff: '2026-08-18T20:00:00Z',
      _scored: {
        total_corners_over8_5: { prob_final: 0.61, confidence: 0.84, n: 25 },
        away_goals_2h_under2_5: { prob_final: 0.99, confidence: 0.95, n: 40 },
      },
    },
  }];
  const rows = buildFootballPersonalMarketRows(analyses, '2026-08-18');
  assert.equal(rows.length, 60);
  assert.equal(rows.find(row => row.market_key === 'total_corners_over8_5').probability, 61);
  assert.equal(rows.find(row => row.market_key === 'away_goals_2h_under2_5').reliability, 95);
  assert.equal(rows.find(row => row.market_key === 'home_goals_over0_5').probability, null);

  const csv = renderFootballPersonalMarketCsv(rows);
  assert.ok(csv.startsWith('\uFEFFPartido;Hora;Línea;Probabilidad;Fiabilidad'));
  assert.match(csv, /61,00%;84,00%/);
  assert.doesNotMatch(csv, /home_goals_over0_5/);
  assert.doesNotMatch(csv, /Fixture|Liga|Muestra|Clave interna/);
  assert.equal(csv.trim().split('\n')[1].split(';').length, 5);
  assert.equal(rows.find(row => row.market_key === 'home_goals_over0_5').linea, '≥ 1 gol (Más de 0.5)');
});

test('el endpoint exige secreto y entrega CSV como archivo', () => {
  const route = fs.readFileSync(
    path.join(__dirname, '../app/api/cron/personal-market-report/route.js'),
    'utf8',
  );
  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /Content-Disposition/);
  assert.match(route, /text\/csv/);
});
