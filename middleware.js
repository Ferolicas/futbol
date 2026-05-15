import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import { rateLimiters, RATE_LIMIT_MESSAGE } from './lib/ratelimit';

/**
 * Middleware — dos responsabilidades:
 *   1. Refrescar la sesion Supabase + bloqueo de paginas protegidas sin sesion
 *   2. Rate limiting de /api/* via Upstash RateLimit
 *
 * Los checks de plan activo y rol admin se hacen en los layouts
 * (`app/dashboard/layout.js`, `app/admin/layout.js`) — Edge runtime no
 * puede hablar con el VPS Postgres por TCP, ver commit c6fbdda.
 */

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
  let supabaseResponse = NextResponse.next({ request });

  const { pathname } = request.nextUrl;
  const bucket = pickBucket(pathname);

  // ── Rate limiting (antes de auth para no malgastar la query a Supabase) ──
  // Para el bucket 'admin' (scope: 'user') necesitamos identificar al user,
  // asi que diferimos la decision hasta DESPUES de getUser(). Para el resto
  // (scope: 'ip') resolvemos ya con la IP del request.
  let ipRateLimitDone = false;
  if (bucket && bucket.scope === 'ip' && rateLimiters[bucket.name]) {
    const ip = clientIp(request);
    const r = await rateLimiters[bucket.name].limit(ip);
    ipRateLimitDone = true;
    if (!r.success) return rateLimitedResponse(r.reset);
  }

  // ── Refresh de sesion Supabase ──
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();

  // ── Rate limit scope: 'user' (admin/ferney) — ahora que sabemos quien es ──
  if (!ipRateLimitDone && bucket && bucket.scope === 'user' && rateLimiters[bucket.name]) {
    // Si no hay user, caemos a IP como identifier — es la actitud conservadora:
    // un actor sin sesion no debe poder reventar /api/admin/* con anonymous keys.
    const id = user?.id || `ip:${clientIp(request)}`;
    const r = await rateLimiters[bucket.name].limit(id);
    if (!r.success) return rateLimitedResponse(r.reset);
  }

  // ── Bloqueo de paginas protegidas sin sesion ──
  const protectedPaths = ['/dashboard', '/admin', '/ferney'];
  const needsAuth = protectedPaths.some(p => pathname.startsWith(p));
  if (needsAuth && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
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
