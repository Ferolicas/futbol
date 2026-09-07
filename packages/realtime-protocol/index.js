import { z } from 'zod';

const NumericPairSchema = z.object({
  home: z.number().nullable().optional(),
  away: z.number().nullable().optional(),
}).passthrough();

const CounterSchema = NumericPairSchema.extend({
  total: z.number().nullable().optional(),
  isReal: z.boolean().optional(),
});

const StatusSchema = z.object({
  short: z.string().min(1),
  elapsed: z.number().nullable().optional(),
}).passthrough();

export const FixtureChangesSchema = z.object({
  status: StatusSchema.optional(),
  goals: NumericPairSchema.optional(),
  score: z.record(z.string(), z.unknown()).optional(),
  elapsed: z.number().nullable().optional(),
  corners: CounterSchema.optional(),
  yellowCards: CounterSchema.optional(),
  redCards: CounterSchema.optional(),
  goalScorers: z.array(z.record(z.string(), z.unknown())).optional(),
  missedPenalties: z.array(z.record(z.string(), z.unknown())).optional(),
  cardEvents: z.array(z.record(z.string(), z.unknown())).optional(),
  events: z.array(z.record(z.string(), z.unknown())).optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
  realFinal: z.boolean().optional(),
}).strict().refine((changes) => Object.keys(changes).length > 0, {
  message: 'Fixture delta must contain at least one change',
});

export const FixtureDeltaSchema = z.object({
  fixtureId: z.number().int().positive(),
  seq: z.number().int().positive(),
  timestamp: z.string().datetime(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.enum(['early', 'detail', 'reconciliation', 'corners']).optional(),
  changes: FixtureChangesSchema,
}).strict();

export const REALTIME_FIXTURE_FIELDS = Object.freeze([
  'status',
  'goals',
  'score',
  'elapsed',
  'corners',
  'yellowCards',
  'redCards',
  'goalScorers',
  'missedPenalties',
  'cardEvents',
  'events',
  'stats',
  'realFinal',
]);

function equalValue(left, right) {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diffFixtureState(previous, incoming) {
  const changes = {};
  for (const field of REALTIME_FIXTURE_FIELDS) {
    const value = incoming?.[field];
    if (value == null || equalValue(previous?.[field], value)) continue;
    changes[field] = value;
  }
  return changes;
}

export function applyFixtureChanges(previous, changes) {
  return { ...(previous || {}), ...(changes || {}) };
}

export function parseFixtureDelta(value) {
  const result = FixtureDeltaSchema.safeParse(value);
  return result.success ? result.data : null;
}
