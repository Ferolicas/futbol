import { z } from 'zod';

export const REALTIME_WS_PROTOCOL: 'cfanalisis-realtime-v1';
export const REALTIME_WS_TOKEN_PREFIX: 'cfjwt.';
export const FixtureChangesSchema: z.ZodType<Record<string, unknown>>;
export const FixtureDeltaSchema: z.ZodType<FixtureDelta>;
export const REALTIME_FIXTURE_FIELDS: readonly string[];

export type FixtureDelta = {
  fixtureId: number;
  seq: number;
  timestamp: string;
  date?: string;
  source?: 'early' | 'detail' | 'reconciliation' | 'corners';
  changes: Record<string, unknown>;
};

export function diffFixtureState(
  previous: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown>;

export function applyFixtureChanges(
  previous: Record<string, unknown> | null | undefined,
  changes: Record<string, unknown> | null | undefined,
): Record<string, unknown>;

export function parseFixtureDelta(value: unknown): FixtureDelta | null;
