import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeApiSportsOdds } from '../lib/api-sports-multisport.js';
import { posteriorReliabilityPercent, evidenceSample, entryReliabilityPercent } from '../lib/reliability.js';

const fixture = {
  teams: { home: { id: 1, name: 'Boston Red Sox' }, away: { id: 2, name: 'Chicago White Sox' } },
};

// Payload real de API-Baseball para Boston–Chicago White Sox del 6 de agosto de
// 2026: el mercado 11 se anuncia como 1.ª entrada pero su escalera es la de un
// total de varias entradas, y contradice al mercado 38 de la misma casa.
function payloadWith(bets) {
  return [{ bookmakers: [{ id: 2, name: 'Bet365', bets }] }];
}

const RUN_1ST_INNING = {
  id: 38,
  name: 'A Run (1st Inning)',
  values: [{ value: 'Yes', odd: '2.00' }, { value: 'No', odd: '1.76' }],
};

const LADDER_1ST_INNING = {
  id: 11,
  name: 'Over/Under (1st Inning)',
  values: [
    { value: 'Over 0.5', odd: '1.16' }, { value: 'Under 0.5', odd: '5.00' },
    { value: 'Over 1.5', odd: '1.68' }, { value: 'Under 1.5', odd: '2.15' },
    { value: 'Over 2.5', odd: '2.80' }, { value: 'Under 2.5', odd: '1.42' },
    { value: 'Over 3.5', odd: '4.50' }, { value: 'Under 3.5', odd: '1.20' },
  ],
};

test('descarta la escalera de 1.ª entrada que contradice al mercado de carrera', () => {
  const odds = normalizeApiSportsOdds(
    payloadWith([RUN_1ST_INNING, LADDER_1ST_INNING]),
    fixture,
    { sport: 'baseball', bookmakers: ['Bet365'] },
  );

  // 1/1.16 = 86% frente a 1/2.00 = 50% para el mismo suceso → escalera fuera.
  assert.deepEqual(odds.periods.inning1.totals, {});
  assert.equal(odds.catalog.some((entry) => entry.family === 'inning1_total'), false);
  // El mercado inequívoco se conserva intacto.
  assert.equal(odds.periods.inning1.specials.run_yes.odd, 2);
  assert.equal(odds.periods.inning1.specials.run_no.odd, 1.76);
});

test('conserva la escalera de 1.ª entrada cuando concuerda con el mercado de carrera', () => {
  const coherente = {
    ...LADDER_1ST_INNING,
    values: [
      { value: 'Over 0.5', odd: '2.05' }, { value: 'Under 0.5', odd: '1.80' },
      { value: 'Over 1.5', odd: '4.00' }, { value: 'Under 1.5', odd: '1.25' },
    ],
  };
  const odds = normalizeApiSportsOdds(
    payloadWith([RUN_1ST_INNING, coherente]),
    fixture,
    { sport: 'baseball', bookmakers: ['Bet365'] },
  );

  // 1/2.05 = 49% frente a 1/2.00 = 50% → dentro de tolerancia, se publica.
  assert.equal(odds.periods.inning1.totals['0.5'].over.odd, 2.05);
  assert.equal(odds.periods.inning1.totals['1.5'].under.odd, 1.25);
});

test('sin el mercado de contraste la escalera no se toca', () => {
  const odds = normalizeApiSportsOdds(
    payloadWith([LADDER_1ST_INNING]),
    fixture,
    { sport: 'baseball', bookmakers: ['Bet365'] },
  );
  assert.equal(odds.periods.inning1.totals['3.5'].under.odd, 1.2);
});

test('la fiabilidad distingue una muestra corta de una larga con el mismo porcentaje', () => {
  // 4 de 5 y 400 de 500 son ambos 80%.
  const corta = posteriorReliabilityPercent(4, 5, 0.70);
  const larga = posteriorReliabilityPercent(400, 500, 0.70);
  assert.ok(corta < 80, `muestra corta debería quedar por debajo de 80, fue ${corta}`);
  assert.ok(larga > 99, `muestra larga debería superar 99, fue ${larga}`);
});

test('la fiabilidad rechaza lo que no tiene muestra que auditar', () => {
  assert.equal(posteriorReliabilityPercent(0, 0, 0.7), null);
  assert.equal(posteriorReliabilityPercent(3, null, 0.7), null);
  assert.equal(posteriorReliabilityPercent(9, 5, 0.7), null);
  assert.equal(evidenceSample(null), null);
  assert.equal(evidenceSample({ n: 0 }), null);
});

test('la fiabilidad reconstruye los aciertos cuando la evidencia solo trae el ratio', () => {
  assert.deepEqual(evidenceSample({ n: 120, rawProbability: 0.75 }), { hits: 90, n: 120 });
  assert.deepEqual(evidenceSample({ n: 120, hits: 90 }), { hits: 90, n: 120 });
});

test('la fiabilidad estructurada respeta 65/35 y 50/50 en lugar de mezclar todo', () => {
  const entry = {
    evidence: {
      currentShareContract: 0.65,
      teams: ['home', 'away'].map((participant) => ({
        participant,
        current: { n: 10, hits: 10 },
        historical: { n: 100, hits: 60 },
      })),
    },
  };
  // El pool bruto sería 140/220 = 63,6% y declararía fiabilidad casi nula.
  // El contrato correcto reconoce 100% actual al 65% y 60% histórico al 35%.
  assert.ok(entryReliabilityPercent(entry, 70) > 99);
});
