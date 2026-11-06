import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeLegs, betOutcome, classifyMarketFamily, classifyMarketPeriod, combinedOdd, legTeamSide, splitMatchName, summarizeBets,
} from '../lib/paper-bets.js';

test('apuestas sin dinero: clasifica la familia y el periodo de cada mercado', () => {
  assert.equal(classifyMarketFamily({ id: 'ml-home', name: 'Boston Celtics gana' }), 'ganador');
  assert.equal(classifyMarketFamily({ id: 'handicap-away-m7_5', name: 'Boston Celtics -7.5' }), 'handicap');
  assert.equal(classifyMarketFamily({ id: 'total-209.5-over', name: 'Más de 209.5 puntos' }), 'total');
  assert.equal(classifyMarketFamily({ id: 'team-total-away-99.5-over', name: 'Boston Celtics: más de 99.5 puntos' }), 'total_equipo');
  assert.equal(classifyMarketFamily({ id: 'x', name: 'Total partido — Córners — Menos de 13.5' }), 'corners');
  assert.equal(classifyMarketFamily({ id: 'x', name: 'Más de 3.5 tarjetas' }), 'tarjetas');
  assert.equal(classifyMarketFamily({ id: 'player-points-NBA:PLAYER:1-14.5-over', name: 'Jayson Tatum: 15 o más puntos', scope: 'player' }), 'jugador');
  assert.equal(classifyMarketFamily({ id: 'x', name: 'Ambos equipos marcan: sí' }), 'ambos_marcan');
  assert.equal(classifyMarketPeriod({ id: 'quarter1-moneyline-home', name: 'Celtics gana en 1.º cuarto' }), '1.er cuarto');
  assert.equal(classifyMarketPeriod({ id: 'total-209.5-over', name: 'Más de 209.5 puntos' }), null);
});

test('apuestas sin dinero: atribuye la selección al equipo correcto', () => {
  const match = { homeTeam: 'Charlotte Hornets', awayTeam: 'Boston Celtics' };
  assert.equal(legTeamSide({ ...match, id: 'team-total-away-99.5-over', name: 'Boston Celtics: más de 99.5 puntos' }), 'away');
  assert.equal(legTeamSide({ ...match, id: 'ml-home', name: 'Charlotte Hornets gana', side: 'home' }), 'home');
  assert.equal(legTeamSide({ ...match, id: 'total-209.5-over', name: 'Más de 209.5 puntos', side: 'over' }), null);
  assert.deepEqual(splitMatchName('Charlotte Hornets vs Boston Celtics'), { home: 'Charlotte Hornets', away: 'Boston Celtics' });
});

test('apuestas sin dinero: una perdida pierde la combinada y una nula sale con cuota 1', () => {
  const leg = (status, odd) => ({ status, odd });
  assert.equal(combinedOdd([leg('pending', 1.5), leg('pending', 2)]), 3);
  assert.deepEqual(betOutcome(100, [leg('won', 1.5), leg('pending', 2)]), { status: 'open', payout: null });
  assert.deepEqual(betOutcome(100, [leg('won', 1.5), leg('lost', 2), leg('pending', 3)]), { status: 'lost', payout: 0 });
  assert.deepEqual(betOutcome(100, [leg('won', 1.5), leg('void', 2)]), { status: 'won', payout: 150 });
  assert.deepEqual(betOutcome(100, [leg('void', 1.5)]), { status: 'void', payout: 100 });
  assert.deepEqual(betOutcome(100, [leg('won', 1.5), leg('won', 2)]), { status: 'won', payout: 300 });
});

test('apuestas sin dinero: el resumen ignora las abiertas y mide beneficio y acierto', () => {
  const summary = summarizeBets([
    { status: 'won', stake: 100, payout: 250 }, { status: 'lost', stake: 100, payout: 0 },
    { status: 'void', stake: 50, payout: 50 }, { status: 'open', stake: 500, payout: null },
  ]);
  assert.equal(summary.staked, 250);
  assert.equal(summary.returned, 300);
  assert.equal(summary.profit, 50);
  assert.equal(summary.roi, 20);
  assert.equal(summary.hitRate, 50);
  assert.equal(summary.open, 1);
});

test('apuestas sin dinero: la analítica separa familia y equipo, y un total cuenta para ambos', () => {
  const base = { sport: 'football', home_team: 'Arsenal', away_team: 'Chelsea', odd: 1.8 };
  const result = analyzeLegs([
    { ...base, market_family: 'corners', team_side: 'home', status: 'won' },
    { ...base, market_family: 'corners', team_side: 'home', status: 'lost' },
    { ...base, market_family: 'total', team_side: null, status: 'won' },
    { ...base, market_family: 'total', team_side: null, status: 'pending' },
  ]);
  const corners = result.families.find((row) => row.family === 'corners');
  assert.deepEqual([corners.legs, corners.won, corners.lost, corners.hitRate], [2, 1, 1, 50]);
  assert.equal(result.teams.find((row) => row.family === 'corners' && row.team === 'Arsenal').legs, 2);
  assert.equal(result.teams.find((row) => row.family === 'corners' && row.team === 'Chelsea'), undefined);
  assert.equal(result.teams.find((row) => row.family === 'total' && row.team === 'Chelsea').hitRate, 100);
});

test('apuestas sin dinero: «Crear apuesta» usa la cuota conjunta y no multiplica el partido', async () => {
  const { hasSameMatchSelections, oddGroups } = await import('../lib/paper-bets.js');
  const leg = (fixture, status, odd, groupOdd = null) => ({ sport: 'football', fixture_id: fixture, status, odd, group_odd: groupOdd });
  const builder = [leg('1', 'won', 1.5, 3.2), leg('1', 'won', 1.8, 3.2), leg('2', 'won', 2)];
  assert.equal(oddGroups(builder).length, 2);
  assert.equal(combinedOdd(builder), 6.4);
  assert.deepEqual(betOutcome(10, builder), { status: 'won', payout: 64 });
  assert.deepEqual(betOutcome(10, [leg('1', 'won', 1.5, 3.2), leg('1', 'lost', 1.8, 3.2), leg('2', 'won', 2)]), { status: 'lost', payout: 0 });
  // Una selección nula dentro del «Crear apuesta» anula ese grupo (cuota 1).
  assert.deepEqual(betOutcome(10, [leg('1', 'won', 1.5, 3.2), leg('1', 'void', 1.8, 3.2), leg('2', 'won', 2)]), { status: 'won', payout: 20 });
  assert.equal(hasSameMatchSelections([{ fixtureId: 7 }, { fixtureId: '7' }]), true);
  assert.equal(hasSameMatchSelections([{ fixtureId: 7 }, { fixtureId: 8 }]), false);
});
