import { useCallback, useSyncExternalStore } from 'react';

// Store granular de estadísticas en vivo de fútbol (port de
// app/dashboard/realtime/fixture-store.js). Cada tarjeta se suscribe solo a su
// fixture; un delta del partido 1005 no vuelve a renderizar las demás.

const EMPTY_FIXTURE = Object.freeze({}) as Record<string, any>;
const LIVE = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE']);
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const PENDING = new Set(['NS', 'TBD']);
const EVENT_ARRAY_FIELDS = ['goalScorers', 'missedPenalties', 'cardEvents', 'events'];
const COUNTER_FIELDS = ['corners', 'yellowCards', 'redCards'];
const DELTA_FIELDS = new Set(['status', 'goals', 'score', 'elapsed', 'corners', 'yellowCards', 'redCards', 'goalScorers', 'missedPenalties', 'cardEvents', 'events', 'stats', 'realFinal']);

const fixtures = new Map<number, Record<string, any>>();
const sequences = new Map<number, number>();
const fixtureListeners = new Map<number, Set<() => void>>();
const allListeners = new Set<() => void>();
let allSnapshot: Record<string, any> = Object.freeze({});

function fixtureKey(fixtureId: unknown): number | null {
  const key = Number(fixtureId);
  return Number.isInteger(key) && key > 0 ? key : null;
}

const isCoveredCounter = (counter: any) => counter?.isReal === true || Number(counter?.total || 0) > 0;

function rejectsStatusRegression(current?: string, incoming?: string) {
  if (!current || !incoming || current === incoming) return false;
  if (FINISHED.has(current) && !FINISHED.has(incoming)) return true;
  return LIVE.has(current) && PENDING.has(incoming);
}

function monotonicCounter(current: any, incoming: any) {
  if (!isCoveredCounter(incoming)) return current || incoming;
  if (!isCoveredCounter(current)) return incoming;
  const home = Math.max(Number(current.home || 0), Number(incoming.home || 0));
  const away = Math.max(Number(current.away || 0), Number(incoming.away || 0));
  return { ...current, ...incoming, home, away, total: home + away };
}

function mergeFixtureState(current: any, incoming: any) {
  const existing = current || {};
  const fresh = incoming || {};
  const keep = rejectsStatusRegression(existing.status?.short, fresh.status?.short);
  const next: Record<string, any> = {
    ...existing,
    ...fresh,
    fixtureId: fresh.fixtureId ?? existing.fixtureId,
    status: keep ? existing.status : (fresh.status || existing.status),
    goals: keep ? existing.goals : (fresh.goals || existing.goals),
    score: keep ? existing.score : (fresh.score || existing.score),
    elapsed: keep ? existing.elapsed : (fresh.elapsed ?? fresh.status?.elapsed ?? existing.elapsed),
  };
  for (const field of COUNTER_FIELDS) next[field] = monotonicCounter(existing[field], fresh[field]);
  for (const field of EVENT_ARRAY_FIELDS) next[field] = fresh[field]?.length > 0 ? fresh[field] : (existing[field] || fresh[field] || []);
  return next;
}

function publishFixture(fixtureId: number, next: Record<string, any>) {
  const previous = fixtures.get(fixtureId);
  if (previous === next || JSON.stringify(previous) === JSON.stringify(next)) return false;
  fixtures.set(fixtureId, next);
  allSnapshot = Object.freeze({ ...allSnapshot, [fixtureId]: next });
  for (const listener of fixtureListeners.get(fixtureId) || []) listener();
  for (const listener of allListeners) listener();
  return true;
}

export function getFixtureLiveStats(fixtureId: unknown) {
  const key = fixtureKey(fixtureId);
  return key == null ? EMPTY_FIXTURE : (fixtures.get(key) || EMPTY_FIXTURE);
}

export function getLiveStatsSnapshot() {
  return allSnapshot;
}

export function subscribeFixtureLiveStats(fixtureId: unknown, listener: () => void) {
  const key = fixtureKey(fixtureId);
  if (key == null) return () => {};
  let listeners = fixtureListeners.get(key);
  if (!listeners) { listeners = new Set(); fixtureListeners.set(key, listeners); }
  listeners.add(listener);
  return () => { listeners!.delete(listener); if (!listeners!.size) fixtureListeners.delete(key); };
}

export function setFixtureLiveStats(fixtureId: unknown, value: any) {
  const key = fixtureKey(fixtureId);
  if (key == null || !value || typeof value !== 'object') return false;
  const current = fixtures.get(key) || {};
  return publishFixture(key, mergeFixtureState(current, { ...value, fixtureId: key }));
}

export function mergeLiveStats(snapshot: Record<string, any> | null | undefined) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  let changed = false;
  for (const [fixtureId, value] of Object.entries(snapshot)) changed = setFixtureLiveStats(fixtureId, value) || changed;
  return changed;
}

export function replaceLiveStats(snapshot: Record<string, any> = {}) {
  const changedIds = new Set(fixtures.keys());
  fixtures.clear();
  sequences.clear();
  allSnapshot = Object.freeze({});
  for (const [rawId, value] of Object.entries(snapshot || {})) {
    const fixtureId = fixtureKey(rawId);
    if (fixtureId == null || !value || typeof value !== 'object') continue;
    const next = mergeFixtureState({}, { ...value, fixtureId });
    fixtures.set(fixtureId, next);
    allSnapshot = Object.freeze({ ...allSnapshot, [fixtureId]: next });
    changedIds.add(fixtureId);
  }
  for (const fixtureId of changedIds) for (const listener of fixtureListeners.get(fixtureId) || []) listener();
  for (const listener of allListeners) listener();
}

/** Valida un `fixture-delta` del worker sin zod (mismas reglas que FixtureDeltaSchema). */
function parseFixtureDelta(value: any) {
  if (!value || typeof value !== 'object') return null;
  const fixtureId = Number(value.fixtureId);
  const seq = Number(value.seq);
  if (!Number.isInteger(fixtureId) || fixtureId <= 0 || !Number.isInteger(seq) || seq <= 0) return null;
  const changes = value.changes;
  if (!changes || typeof changes !== 'object') return null;
  const keys = Object.keys(changes);
  if (!keys.length || keys.some((key) => !DELTA_FIELDS.has(key))) return null;
  if (changes.status && typeof changes.status.short !== 'string') return null;
  return { fixtureId, seq, changes };
}

export function applyFixtureDelta(value: any) {
  const delta = parseFixtureDelta(value);
  if (!delta) return false;
  const last = sequences.get(delta.fixtureId) || 0;
  if (delta.seq <= last) return false;
  sequences.set(delta.fixtureId, delta.seq);
  return setFixtureLiveStats(delta.fixtureId, delta.changes);
}

export function useFixtureLiveStats(fixtureId: unknown): Record<string, any> {
  const key = fixtureKey(fixtureId);
  const subscribe = useCallback((listener: () => void) => subscribeFixtureLiveStats(key, listener), [key]);
  const getSnapshot = useCallback(() => getFixtureLiveStats(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useLiveStatsSnapshot(): Record<string, any> {
  return useSyncExternalStore(
    useCallback((listener: () => void) => { allListeners.add(listener); return () => { allListeners.delete(listener); }; }, []),
    getLiveStatsSnapshot,
    getLiveStatsSnapshot,
  );
}
