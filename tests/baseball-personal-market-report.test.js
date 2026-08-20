const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/cfanalisis_test';
process.env.DATABASE_SSL ||= 'false';

function entry(value, n = 100) {
  return { probability: value * 100, rawProbability: value, evidence: { n, hits: Math.round(value * n) } };
}

test('el informe de béisbol conserva solo carreras, hits, ponches, hándicap y tramos 1/3/5', async () => {
  const { buildBaseballPersonalMarketRows } = await import('../lib/baseball-personal-market-report.js');
  const rows = buildBaseballPersonalMarketRows([{
    fixture_id: 7,
    date: '2026-08-20',
    league_name: 'MLB',
    home_team: 'Yankees',
    away_team: 'Mets',
    start_time: '2026-08-21T00:00:00Z',
    probabilities: {
      evidence: {
        totals: { lines: { 8.5: { over: entry(.7), under: entry(.3) } } },
        teamTotals: { home: { 1.5: { over: entry(.8), under: entry(.2) } }, away: {} },
        spreads: { home: { '-1.5': entry(.65) }, away: {} },
        statistics: { hits: { label: 'hits', total: { 14.5: { over: entry(.72), under: entry(.28) } }, home: { 6.5: { over: entry(.75), under: entry(.25) } }, away: {} } },
        periods: {
          inning1: {
            label: '1.ª entrada', moneyline: {}, spreads: { home: {}, away: {} },
            totals: { .5: { over: entry(.6), under: entry(.4) } }, teamTotals: { home: {}, away: {} },
            run: { yes: entry(.6), no: entry(.4) },
            statistics: { hits: { label: 'hits', total: { 1.5: { over: entry(.7), under: entry(.3) } }, home: {}, away: {} } },
          },
          first3: {
            label: 'primeras 3 entradas', moneyline: {}, spreads: { home: {}, away: {} },
            totals: { 2.5: { over: entry(.7), under: entry(.3) } }, teamTotals: { home: {}, away: {} }, run: {},
            statistics: { hits: { label: 'hits', total: { 4.5: { over: entry(.7), under: entry(.3) } }, home: {}, away: {} } },
          },
          first5: {
            label: 'primeras 5 entradas', moneyline: {}, spreads: { home: {}, away: {} },
            totals: { 4.5: { over: entry(.7), under: entry(.3) } }, teamTotals: { home: {}, away: {} }, run: {},
            statistics: { hits: { label: 'hits', total: { 7.5: { over: entry(.7), under: entry(.3) } }, home: {}, away: {} } },
          },
        },
      },
      players: {
        strikeouts: [{
          id: 99, name: 'Abridor', lineSides: { 5.5: { over: entry(.71), under: entry(.29) } },
        }],
      },
    },
    combinada: { selectable: [] },
  }], '2026-08-20');

  assert.ok(rows.some(row => row.grupo === 'Carreras por equipo'));
  assert.ok(rows.some(row => row.grupo === 'Hits por equipo'));
  assert.ok(rows.some(row => row.grupo === 'Ponches del lanzador'));
  assert.ok(rows.some(row => row.grupo === 'Hándicap'));
  assert.ok(rows.some(row => row.grupo === 'Carreras por entradas' && row.periodo === '1.ª entrada'));
  assert.ok(rows.some(row => row.grupo === 'Hits por entradas' && row.periodo === 'Primeras 3 entradas'));
  assert.ok(rows.some(row => row.grupo === 'Hits por entradas' && row.periodo === 'Primeras 5 entradas'));
  assert.ok(rows.findIndex(row => row.direccion === 'over') < rows.findIndex(row => row.direccion === 'under'));
  assert.ok(rows.every(row => !/ganador|jonr[oó]n|bases totales/i.test(row.grupo)));
});

test('la interfaz privada limita solo la probabilidad visual a 95%', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../app/ferney/informes/MarketReports.js'), 'utf8');
  assert.match(source, /metric\(row\.probability, 95\)/);
  assert.match(source, /metric\(best\?\.probability, 95\)/);
  assert.match(source, /metric\(row\.reliability\)/);
  assert.match(source, /<details className=\{styles\.marketGroup\}/);
});
