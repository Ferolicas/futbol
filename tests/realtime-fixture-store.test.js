import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __fixtureStoreTestUtils,
  applyFixtureDelta,
  getFixtureLiveStats,
  subscribeFixtureLiveStats,
} from '../app/dashboard/realtime/fixture-store.js';
import {
  FixtureDeltaSchema,
  diffFixtureState,
} from '@cfanalisis/realtime-protocol';

function delta(fixtureId, seq, changes) {
  return FixtureDeltaSchema.parse({
    fixtureId,
    seq,
    timestamp: '2026-09-07T12:00:00.000Z',
    date: '2026-09-07',
    source: 'detail',
    changes,
  });
}

test.beforeEach(() => __fixtureStoreTestUtils.reset());

test('un delta despierta solo a los suscriptores del fixture modificado', () => {
  let fixture1003Renders = 0;
  let fixture1005Renders = 0;
  const off1003 = subscribeFixtureLiveStats(1003, () => { fixture1003Renders += 1; });
  const off1005 = subscribeFixtureLiveStats(1005, () => { fixture1005Renders += 1; });

  assert.equal(applyFixtureDelta(delta(1005, 10, {
    corners: { home: 5, away: 3, total: 8, isReal: true },
  })), true);

  assert.equal(fixture1003Renders, 0);
  assert.equal(fixture1005Renders, 1);
  assert.deepEqual(getFixtureLiveStats(1005).corners, {
    home: 5,
    away: 3,
    total: 8,
    isReal: true,
  });
  off1003();
  off1005();
});

test('rechaza deltas fuera de orden y regresiones de estado', () => {
  applyFixtureDelta(delta(123456, 20, {
    status: { short: '2H', elapsed: 70 },
    goals: { home: 2, away: 1 },
  }));

  assert.equal(applyFixtureDelta(delta(123456, 19, {
    goals: { home: 1, away: 1 },
  })), false);
  applyFixtureDelta(delta(123456, 21, {
    status: { short: 'NS', elapsed: 0 },
    goals: { home: 0, away: 0 },
  }));

  assert.equal(getFixtureLiveStats(123456).status.short, '2H');
  assert.deepEqual(getFixtureLiveStats(123456).goals, { home: 2, away: 1 });
});

test('el protocolo calcula únicamente los campos realmente modificados', () => {
  assert.deepEqual(diffFixtureState(
    {
      status: { short: '1H', elapsed: 35 },
      goals: { home: 0, away: 0 },
      corners: { home: 4, away: 3, total: 7, isReal: true },
    },
    {
      status: { short: '1H', elapsed: 35 },
      goals: { home: 0, away: 0 },
      corners: { home: 5, away: 3, total: 8, isReal: true },
    },
  ), {
    corners: { home: 5, away: 3, total: 8, isReal: true },
  });
});
