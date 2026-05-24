import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { rateLimiters, RATE_LIMIT_MESSAGE } from './lib/ratelimit';

/**
 * Middleware — dos responsabilidades:
 *   1. Validar la sesión PG (cookie JWT cf_session) + bloqueo de páginas
 *      protegidas sin sesión.
 *   2. Rate limiting de /api/* (in-memory, ver lib/ratelimit.js).
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

const isApiPath = (p) => p.startsWith('/api/');

// Mapea path → bucket de rate limit.
// Orden importa: las rutas mas especificas se evaluan primero.
function pickBucket(path) {
  if (path.startsWith('/api/auth/'))     return { name: 'auth',     scope: 'ip' };
  if (path.startsWith('/api/checkout'))  return { name: 'checkout', scope: 'ip' };
  if (path.startsWith('/api/register'))  return { name: 'register', scope: 'ip' };
  if (path.startsWith('/api/admin/'))    return { name: 'admin',    scope: 'user' };
  // /ferney es UI, no /api/* — pero su API helper (/api/admin/ferney) ya
  // cae bajo /api/admin/. Aqui lo mantenemos por defensa en profundidad si
  // /ferney llamara a otros endpoints en el futuro.
  if (path.startsWith('/ferney'))        return { name: 'admin',    scope: 'user' };
  if (isApiPath(path))                   return { name: 'apiGen',   scope: 'ip' };
  return null;
}

function clientIp(request) {
  // Vercel pone la IP real en x-forwarded-for; tomamos el primer hop
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'anonymous';
}

function rateLimitedResponse(reset) {
  // reset es timestamp ms cuando se restaura la cuota
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  return new NextResponse(
    JSON.stringify({ error: RATE_LIMIT_MESSAGE }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Reset': String(Math.ceil(reset / 1000)),
      },
    },
  );
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  const bucket = pickBucket(pathname);

  // ── Rate limiting (antes de auth) ──
  // Para 'admin' (scope: 'user') diferimos hasta saber el user. Para el resto
  // (scope: 'ip') resolvemos ya con la IP.
  let ipRateLimitDone = false;
  if (bucket && bucket.scope === 'ip' && rateLimiters[bucket.name]) {
    const ip = clientIp(request);
    const r = await rateLimiters[bucket.name].limit(ip);
    ipRateLimitDone = true;
    if (!r.success) return rateLimitedResponse(r.reset);
  }

  // ── Validar sesión PG (cookie JWT) — solo firma + expiry, sin DB ──
  const token = request.cookies.get(COOKIE_NAME)?.value || null;
  const payload = await verifySessionToken(token);
  const userId = payload?.uid || null;

  // ── Rate limit scope: 'user' (admin/ferney) ──
  if (!ipRateLimitDone && bucket && bucket.scope === 'user' && rateLimiters[bucket.name]) {
    const id = userId || `ip:${clientIp(request)}`;
    const r = await rateLimiters[bucket.name].limit(id);
    if (!r.success) return rateLimitedResponse(r.reset);
  }

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
    // Rate limiting de APIs — el middleware ahora intercepta /api/*.
    // Excluimos webhook de Stripe explicitamente: tiene su propio
    // verificador de firma y un rate limit aqui podria perder eventos
    // legitimos durante picos.
    '/api/((?!webhook).*)',
  ],
};
