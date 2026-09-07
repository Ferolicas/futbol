'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { parseFixtureDelta } from '@cfanalisis/realtime-protocol';

const EMPTY_FIXTURE = Object.freeze({});
const LIVE = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE']);
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const PENDING = new Set(['NS', 'TBD']);
const EVENT_ARRAY_FIELDS = ['goalScorers', 'missedPenalties', 'cardEvents', 'events'];
const COUNTER_FIELDS = ['corners', 'yellowCards', 'redCards'];

const fixtures = new Map();
const sequences = new Map();
const fixtureListeners = new Map();
const allListeners = new Set();
let allSnapshot = Object.freeze({});

function fixtureKey(fixtureId) {
  const key = Number(fixtureId);
  return Number.isInteger(key) && key > 0 ? key : null;
}

function isCoveredCounter(counter) {
  return counter?.isReal === true || Number(counter?.total || 0) > 0;
}

function rejectsStatusRegression(current, incoming) {
  if (!current || !incoming || current === incoming) return false;
  if (FINISHED.has(current) && !FINISHED.has(incoming)) return true;
  return LIVE.has(current) && PENDING.has(incoming);
}

function monotonicCounter(current, incoming) {
  if (!isCoveredCounter(incoming)) return current || incoming;
  if (!isCoveredCounter(current)) return incoming;
  const home = Math.max(Number(current.home || 0), Number(incoming.home || 0));
  const away = Math.max(Number(current.away || 0), Number(incoming.away || 0));
  return { ...current, ...incoming, home, away, total: home + away };
}

function mergeFixtureState(current, incoming) {
  const existing = current || {};
  const fresh = incoming || {};
  const keepObservedState = rejectsStatusRegression(existing.status?.short, fresh.status?.short);
  const next = {
    ...existing,
    ...fresh,
    fixtureId: fresh.fixtureId ?? existing.fixtureId,
    status: keepObservedState ? existing.status : (fresh.status || existing.status),
    goals: keepObservedState ? existing.goals : (fresh.goals || existing.goals),
    score: keepObservedState ? existing.score : (fresh.score || existing.score),
    elapsed: keepObservedState
      ? existing.elapsed
      : (fresh.elapsed ?? fresh.status?.elapsed ?? existing.elapsed),
  };

  for (const field of COUNTER_FIELDS) {
    next[field] = monotonicCounter(existing[field], fresh[field]);
  }
  for (const field of EVENT_ARRAY_FIELDS) {
    next[field] = fresh[field]?.length > 0 ? fresh[field] : (existing[field] || fresh[field] || []);
  }
  return next;
}

function equalFixture(left, right) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function publishFixture(fixtureId, next) {
  const previous = fixtures.get(fixtureId);
  if (equalFixture(previous, next)) return false;
  fixtures.set(fixtureId, next);
  allSnapshot = Object.freeze({ ...allSnapshot, [fixtureId]: next });
  for (const listener of fixtureListeners.get(fixtureId) || []) listener();
  for (const listener of allListeners) listener();
  return true;
}

export function getFixtureLiveStats(fixtureId) {
  const key = fixtureKey(fixtureId);
  return key == null ? EMPTY_FIXTURE : (fixtures.get(key) || EMPTY_FIXTURE);
}

export function getLiveStatsSnapshot() {
  return allSnapshot;
}

export function subscribeFixtureLiveStats(fixtureId, listener) {
  const key = fixtureKey(fixtureId);
  if (key == null) return () => {};
  let listeners = fixtureListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    fixtureListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) fixtureListeners.delete(key);
  };
}

export function setFixtureLiveStats(fixtureId, valueOrUpdater) {
  const key = fixtureKey(fixtureId);
  if (key == null) return false;
  const current = fixtures.get(key) || {};
  const incoming = typeof valueOrUpdater === 'function'
    ? valueOrUpdater(current)
    : valueOrUpdater;
  if (!incoming || typeof incoming !== 'object') return false;
  return publishFixture(key, mergeFixtureState(current, { ...incoming, fixtureId: key }));
}

export function mergeLiveStats(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  let changed = false;
  for (const [fixtureId, value] of Object.entries(snapshot)) {
    changed = setFixtureLiveStats(fixtureId, value) || changed;
  }
  return changed;
}

export function replaceLiveStats(snapshot = {}) {
  const previousIds = new Set(fixtures.keys());
  fixtures.clear();
  sequences.clear();
  allSnapshot = Object.freeze({});

  const changedIds = new Set(previousIds);
  for (const [rawFixtureId, value] of Object.entries(snapshot || {})) {
    const fixtureId = fixtureKey(rawFixtureId);
    if (fixtureId == null || !value || typeof value !== 'object') continue;
    const next = mergeFixtureState({}, { ...value, fixtureId });
    fixtures.set(fixtureId, next);
    allSnapshot = Object.freeze({ ...allSnapshot, [fixtureId]: next });
    changedIds.add(fixtureId);
  }

  for (const fixtureId of changedIds) {
    for (const listener of fixtureListeners.get(fixtureId) || []) listener();
  }
  for (const listener of allListeners) listener();
}

export function applyFixtureDelta(value) {
  const delta = parseFixtureDelta(value);
  if (!delta) return false;
  const lastSequence = sequences.get(delta.fixtureId) || 0;
  if (delta.seq <= lastSequence) return false;
  sequences.set(delta.fixtureId, delta.seq);
  return setFixtureLiveStats(delta.fixtureId, delta.changes);
}

export function useFixtureLiveStats(fixtureId) {
  const key = fixtureKey(fixtureId);
  const subscribe = useCallback(
    (listener) => subscribeFixtureLiveStats(key, listener),
    [key],
  );
  const getSnapshot = useCallback(() => getFixtureLiveStats(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useLiveStatsSnapshot() {
  return useSyncExternalStore(
    useCallback((listener) => {
      allListeners.add(listener);
      return () => allListeners.delete(listener);
    }, []),
    getLiveStatsSnapshot,
    getLiveStatsSnapshot,
  );
}

export const __fixtureStoreTestUtils = {
  reset() {
    fixtures.clear();
    sequences.clear();
    allSnapshot = Object.freeze({});
    fixtureListeners.clear();
    allListeners.clear();
  },
};
