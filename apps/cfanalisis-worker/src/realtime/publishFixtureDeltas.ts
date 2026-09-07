import {
  FixtureDeltaSchema,
  applyFixtureChanges,
  diffFixtureState,
  type FixtureDelta,
} from '@cfanalisis/realtime-protocol';
import { triggerEvent } from '../ws/wsManager.js';
import { recordFixtureDeltas } from '../metrics.js';

type FixtureState = Record<string, unknown>;
export type FixtureDeltaState = Map<number, FixtureState>;

const EVENT_ARRAY_FIELDS = ['goalScorers', 'missedPenalties', 'cardEvents', 'events'] as const;
const COUNTER_FIELDS = ['corners', 'yellowCards', 'redCards'] as const;
const lastSequenceByFixture = new Map<number, number>();

function nextSequence(fixtureId: number): number {
  // Epoch-based and monotonic per fixture: it survives process restarts without
  // a Redis round-trip in the hot path and lets clients reject stale packets.
  const base = Date.now() * 1_000;
  const seq = Math.max(base, (lastSequenceByFixture.get(fixtureId) || 0) + 1);
  lastSequenceByFixture.set(fixtureId, seq);
  return seq;
}

function coveredCounter(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const counter = value as { isReal?: boolean; total?: unknown };
  return counter.isReal === true || Number(counter.total || 0) > 0;
}

function normalizeCandidate(candidate: FixtureState): FixtureState {
  const normalized: FixtureState = { ...candidate };
  const status = normalized.status as { elapsed?: number | null } | undefined;
  if (status?.elapsed != null) normalized.elapsed = status.elapsed;

  for (const field of EVENT_ARRAY_FIELDS) {
    if (Array.isArray(normalized[field]) && normalized[field].length === 0) {
      delete normalized[field];
    }
  }
  for (const field of COUNTER_FIELDS) {
    if (!coveredCounter(normalized[field])) delete normalized[field];
  }
  return normalized;
}

export function createFixtureDeltaState(snapshot: unknown): FixtureDeltaState {
  const state: FixtureDeltaState = new Map();
  if (!snapshot || typeof snapshot !== 'object') return state;
  for (const [key, value] of Object.entries(snapshot)) {
    const fixtureId = Number(key);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0 || !value || typeof value !== 'object') continue;
    state.set(fixtureId, value as FixtureState);
  }
  return state;
}

export async function publishFixtureDeltas(
  candidates: unknown[],
  state: FixtureDeltaState,
  metadata: Pick<FixtureDelta, 'date' | 'source'> = {},
): Promise<FixtureDelta[]> {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const published: FixtureDelta[] = [];

  for (const rawCandidate of candidates) {
    if (!rawCandidate || typeof rawCandidate !== 'object') continue;
    const candidate = rawCandidate as FixtureState;
    const fixtureId = Number(candidate.fixtureId);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) continue;

    const normalized = normalizeCandidate(candidate);
    const previous = state.get(fixtureId) || {};
    const changes = diffFixtureState(previous, normalized);
    if (Object.keys(changes).length === 0) continue;

    const delta = FixtureDeltaSchema.parse({
      fixtureId,
      seq: nextSequence(fixtureId),
      timestamp: new Date().toISOString(),
      ...(metadata.date ? { date: metadata.date } : {}),
      ...(metadata.source ? { source: metadata.source } : {}),
      changes,
    });
    state.set(fixtureId, applyFixtureChanges(previous, changes));
    published.push(delta);
    await triggerEvent('live-scores', 'fixture-delta', delta);
  }

  recordFixtureDeltas(metadata.source, published.length);

  return published;
}
