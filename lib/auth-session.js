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

function encodeSecret(raw, name) {
  if (!raw || raw.length < 32) {
    throw new Error(`${name} missing or too short. Generate: openssl rand -base64 32`);
  }
  return new TextEncoder().encode(raw);
}

function getSigningSecret() {
  const raw = process.env.AUTH_JWT_SECRET || process.env.NEXTAUTH_SECRET;
  return encodeSecret(raw, 'AUTH_JWT_SECRET');
}

function getVerificationSecrets() {
  const secrets = [getSigningSecret()];
  const previous = process.env.AUTH_JWT_SECRET_PREVIOUS;
  if (previous) secrets.push(encodeSecret(previous, 'AUTH_JWT_SECRET_PREVIOUS'));
  return secrets;
}

/** Firma un JWT con { uid, sid, exp }. */
export async function signSessionJWT(userId, sessionId) {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  return await new SignJWT({ uid: userId, sid: sessionId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(getSigningSecret());
}

/** Verifica firma + expiry. Devuelve payload o null. */
export async function verifySessionJWT(token) {
  if (!token) return null;
  for (const secret of getVerificationSecrets()) {
    try {
      const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
      return payload;
    } catch {
      // Durante la ventana de rotación una cookie puede seguir firmada con la
      // clave anterior. Solo esa segunda clave explícita se acepta.
    }
  }
  return null;
}

/** Pone la cookie de sesión en la response del request actual. */
export async function setSessionCookie(token) {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

/** Lee la cookie de sesión del request actual. */
export async function getSessionCookie() {
  return (await cookies()).get(COOKIE_NAME)?.value || null;
}

/** Borra la cookie (logout). */
export async function clearSessionCookie() {
  (await cookies()).set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export { COOKIE_NAME, COOKIE_MAX_AGE };
