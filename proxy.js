import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

/**
 * Middleware — una sola responsabilidad ahora:
 *   - Validar la sesión PG (cookie JWT __Host-cf_session) + bloqueo de páginas
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

const COOKIE_NAME = process.env.NODE_ENV === 'production' ? '__Host-cf_session' : 'cf_session_dev';
const LEGACY_COOKIE_NAME = 'cf_session';
const JWT_ISSUER = 'cfanalisis.com';
const JWT_AUDIENCE = 'cfanalisis-web';

function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com https://sdk.mercadopago.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https://api.stripe.com https://r.stripe.com https://m.stripe.network https://api.mercadopago.com https://*.mercadopago.com wss://worker.cfanalisis.com",
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://*.stripe.com https://*.mercadopago.com https://*.mercadolibre.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    ...(process.env.NODE_ENV === 'production' ? ["upgrade-insecure-requests"] : []),
  ].join('; ');
}

function csrfRejected(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false;
  if (!request.nextUrl.pathname.startsWith('/api/')) return false;
  const hasSession = request.cookies.has(COOKIE_NAME) || request.cookies.has(LEGACY_COOKIE_NAME);
  if (!hasSession) return false;

  const origin = request.headers.get('origin');
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  const allowed = new Set([
    request.nextUrl.origin,
    'https://cfanalisis.com',
    'https://www.cfanalisis.com',
    ...(configured ? [configured.replace(/\/$/, '')] : []),
  ]);
  if (origin && !allowed.has(origin.replace(/\/$/, ''))) return true;
  return !origin && request.headers.get('sec-fetch-site') === 'cross-site';
}

function getJwtSecrets() {
  const current = process.env.AUTH_JWT_SECRET || process.env.NEXTAUTH_SECRET;
  if (!current || current.length < 32) return [];
  const values = [current];
  const previous = process.env.AUTH_JWT_SECRET_PREVIOUS;
  if (previous?.length >= 32 && previous !== current) values.push(previous);
  return values.map(value => new TextEncoder().encode(value));
}

// Verifica el JWT de sesión (firma + expiry). Devuelve el payload {uid,sid}
// o null. NO consulta la BD — Edge runtime no puede hablar con el VPS PG.
async function verifySessionToken(token) {
  if (!token) return null;
  for (const secret of getJwtSecrets()) {
    try {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      return payload;
    } catch {
      // Probar la clave anterior únicamente durante la ventana de transición.
    }
  }
  return null;
}

export async function proxy(request) {
  const { pathname } = request.nextUrl;
  if (csrfRejected(request)) {
    return Response.json({ error: 'Origen no permitido' }, { status: 403 });
  }

  const nonce = crypto.randomUUID().replaceAll('-', '');
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  // ── Validar sesión PG (cookie JWT) — solo firma + expiry, sin DB ──
  const token = request.cookies.get(COOKIE_NAME)?.value || null;
  const payload = await verifySessionToken(token);
  const userId = payload?.uid || null;

  // ── Bloqueo de páginas protegidas sin sesión ──
  const protectedPaths = ['/dashboard', '/admin', '/ferney'];
  const needsAuth = protectedPaths.some(p => pathname.startsWith(p));
  if (needsAuth && !userId) {
    const destination = `${pathname}${request.nextUrl.search}`;
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = '';
    url.searchParams.set('redirect_url', destination);
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map|woff2?|ttf)$).*)',
  ],
};
