// ──────────────────────────────────────────────────────────────────────────
// JWT signing + cookie helpers — Fase 2.5
//
// Usamos JWT firmado con HS256 (HMAC-SHA256) y secret del .env.
// El cookie httpOnly + secure + samesite=lax guarda solo el session_id.
// El JWT incluye user_id + session_id + exp para validación dual:
//   1. Verificar firma del JWT (rápido, sin DB)
//   2. Verificar session_id existe en auth_sessions (revocable)
//
// Asi podemos revocar sesiones instantaneamente (DB-backed) sin perder la
// velocidad de JWT (no fetch a DB en cada request si el JWT es válido y
// queremos confiar 60s — ver TTL_CACHE).
// ──────────────────────────────────────────────────────────────────────────

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

const ALG = 'HS256';
const COOKIE_NAME = 'cf_session';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;   // 30 días en segundos

function getSecret() {
  const raw = process.env.AUTH_JWT_SECRET || process.env.NEXTAUTH_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('AUTH_JWT_SECRET missing or too short. Generate: openssl rand -base64 32');
  }
  return new TextEncoder().encode(raw);
}

/** Firma un JWT con { uid, sid, exp }. */
export async function signSessionJWT(userId, sessionId) {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  return await new SignJWT({ uid: userId, sid: sessionId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(getSecret());
}

/** Verifica firma + expiry. Devuelve payload o null. */
export async function verifySessionJWT(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: [ALG] });
    return payload;
  } catch {
    return null;
  }
}

/** Pone la cookie de sesión en la response del request actual. */
export function setSessionCookie(token) {
  const store = cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

/** Lee la cookie de sesión del request actual. */
export function getSessionCookie() {
  return cookies().get(COOKIE_NAME)?.value || null;
}

/** Borra la cookie (logout). */
export function clearSessionCookie() {
  cookies().set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export { COOKIE_NAME, COOKIE_MAX_AGE };
