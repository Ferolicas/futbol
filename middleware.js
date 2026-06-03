import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

/**
 * Middleware — una sola responsabilidad ahora:
 *   - Validar la sesión PG (cookie JWT cf_session) + bloqueo de páginas
 *     protegidas sin sesión.
 *
 * RATE LIMITING ELIMINADO (2026-06-03): el limiter in-memory (bucket apiGen
 * 60/min/IP compartido por todo /api/*) provocaba 429 "Demasiadas solicitudes"
 * en el dashboard. La app la usan el owner + 3 amigos → no hay abuso que mitigar.
 * La protección brute-force de los endpoints públicos sensibles (login,
 * register, forgot/reset password) SIGUE viva a nivel de handler vía
 * `redisRateLimit` (lib/ratelimit-redis.js) — eso no toca al dashboard.
 *
 * Auth nativo PG (Fase 2.5): la cookie cf_session es un JWT HS256 firmado
 * con AUTH_JWT_SECRET. Lo verificamos aquí con `jose` (Edge-compatible) SIN
 * tocar la BD — solo validamos firma + expiry. La validación de que la
 * sesión sigue viva en auth_sessions (revocación) la hacen los layouts/rutas
 * vía getCurrentUser(), que sí corren en Node y pueden hablar con el VPS PG.
 *
 * Los checks de plan activo y rol admin se hacen en los layouts
 * (`app/dashboard/layout.js`, `app/admin/layout.js`).
 */

const COOKIE_NAME = 'cf_session';

function getJwtSecret() {
  const raw = process.env.AUTH_JWT_SECRET || process.env.NEXTAUTH_SECRET;
  if (!raw || raw.length < 32) return null;
  return new TextEncoder().encode(raw);
}

// Verifica el JWT de sesión (firma + expiry). Devuelve el payload {uid,sid}
// o null. NO consulta la BD — Edge runtime no puede hablar con el VPS PG.
async function verifySessionToken(token) {
  if (!token) return null;
  const secret = getJwtSecret();
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    return payload;
  } catch {
    return null;
  }
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  // ── Validar sesión PG (cookie JWT) — solo firma + expiry, sin DB ──
  const token = request.cookies.get(COOKIE_NAME)?.value || null;
  const payload = await verifySessionToken(token);
  const userId = payload?.uid || null;

  // ── Bloqueo de páginas protegidas sin sesión ──
  const protectedPaths = ['/dashboard', '/admin', '/ferney'];
  const needsAuth = protectedPaths.some(p => pathname.startsWith(p));
  if (needsAuth && !userId) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/sign-in',
    '/sign-up',
    '/dashboard/:path*',
    '/admin/:path*',
    '/ferney/:path*',
    '/ferney',
    '/planes/:path*',
    // /api/* YA NO pasa por el middleware: el rate limiting se eliminó y la
    // auth de cada endpoint la resuelve su propio handler (getCurrentUser).
  ],
};
