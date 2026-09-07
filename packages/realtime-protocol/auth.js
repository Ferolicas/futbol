import { createHmac, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { REALTIME_WS_PROTOCOL, REALTIME_WS_TOKEN_PREFIX } from './index.js';

export const REALTIME_TOKEN_ISSUER = 'cfanalisis-web';
export const REALTIME_TOKEN_AUDIENCE = 'cfanalisis-realtime';
export const REALTIME_TOKEN_TTL_SECONDS = 5 * 60;

export const PUBLIC_REALTIME_TOPICS = Object.freeze([
  'live-scores',
  'match-updates',
  'analysis',
  'baseball-live',
  'baseball-analysis',
  'basketball-live',
  'basketball-analysis',
  'american_football-live',
  'american_football-analysis',
]);

const UserIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const RoleSchema = z.enum(['user', 'admin', 'owner']);
const RealtimeClaimsSchema = z.object({
  sub: UserIdSchema,
  role: RoleSchema,
  topics: z.array(z.string().min(1).max(128)).max(PUBLIC_REALTIME_TOPICS.length + 2),
  iss: z.literal(REALTIME_TOKEN_ISSUER),
  aud: z.literal(REALTIME_TOKEN_AUDIENCE),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  jti: z.string().uuid(),
}).strict();

function signingKey(workerSecret) {
  if (typeof workerSecret !== 'string' || workerSecret.length < 32) {
    throw new Error('WORKER_SECRET missing or too short');
  }
  return createHmac('sha256', workerSecret)
    .update('cfanalisis:realtime-access:v1')
    .digest();
}

function normalizeRole(role) {
  return RoleSchema.safeParse(role).success ? role : 'user';
}

export function realtimeTopicsForUser(userId, role = 'user') {
  const id = UserIdSchema.parse(String(userId));
  const normalizedRole = normalizeRole(role);
  const topics = [...PUBLIC_REALTIME_TOPICS, `chat-${id}`];
  if (normalizedRole === 'admin' || normalizedRole === 'owner') topics.push('chat-admin');
  return topics;
}

export async function signRealtimeAccessToken({ userId, role = 'user', workerSecret }) {
  const subject = UserIdSchema.parse(String(userId));
  const normalizedRole = normalizeRole(role);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + REALTIME_TOKEN_TTL_SECONDS;
  const topics = realtimeTopicsForUser(subject, normalizedRole);
  const token = await new SignJWT({ role: normalizedRole, topics })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(subject)
    .setIssuer(REALTIME_TOKEN_ISSUER)
    .setAudience(REALTIME_TOKEN_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(signingKey(workerSecret));
  return { token, topics, expiresAt: expiresAt * 1000 };
}

export async function verifyRealtimeAccessToken(token, workerSecret) {
  if (typeof token !== 'string' || token.length < 80 || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(workerSecret), {
      algorithms: ['HS256'],
      issuer: REALTIME_TOKEN_ISSUER,
      audience: REALTIME_TOKEN_AUDIENCE,
      maxTokenAge: '6m',
      clockTolerance: 5,
    });
    const parsed = RealtimeClaimsSchema.safeParse(payload);
    if (!parsed.success) return null;
    const claims = parsed.data;
    const permitted = new Set(realtimeTopicsForUser(claims.sub, claims.role));
    if (claims.topics.some((topic) => !permitted.has(topic))) return null;
    return {
      userId: claims.sub,
      role: claims.role,
      topics: claims.topics,
      expiresAt: claims.exp * 1000,
    };
  } catch {
    return null;
  }
}

export function readRealtimeTokenFromProtocols(headerValue) {
  const value = Array.isArray(headerValue) ? headerValue.join(',') : String(headerValue || '');
  const protocols = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!protocols.includes(REALTIME_WS_PROTOCOL)) return null;
  const credential = protocols.find((item) => item.startsWith(REALTIME_WS_TOKEN_PREFIX));
  return credential ? credential.slice(REALTIME_WS_TOKEN_PREFIX.length) : null;
}
