export const REALTIME_TOKEN_ISSUER: 'cfanalisis-web';
export const REALTIME_TOKEN_AUDIENCE: 'cfanalisis-realtime';
export const REALTIME_TOKEN_TTL_SECONDS: number;
export const PUBLIC_REALTIME_TOPICS: readonly string[];

export type RealtimeRole = 'user' | 'admin' | 'owner';
export type RealtimeAccess = {
  userId: string;
  role: RealtimeRole;
  topics: string[];
  expiresAt: number;
};

export function realtimeTopicsForUser(userId: string | number, role?: string): string[];
export function signRealtimeAccessToken(input: {
  userId: string | number;
  role?: string;
  workerSecret: string;
}): Promise<{ token: string; topics: string[]; expiresAt: number }>;
export function verifyRealtimeAccessToken(
  token: string | null | undefined,
  workerSecret: string,
): Promise<RealtimeAccess | null>;
export function readRealtimeTokenFromProtocols(headerValue: string | string[] | undefined): string | null;
