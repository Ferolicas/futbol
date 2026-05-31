// Login — auth nativo PG VPS (Fase 2.5 cerrada).
// loginUser de lib/auth-pg.js: valida bcrypt, maneja lockout por intentos
// fallidos, crea sesión (cookie JWT httpOnly). Reemplaza el login client-side
// que antes hacía supabase.auth.signInWithPassword en el browser.
import { loginUser } from '../../../../lib/auth-pg';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    // A2: rate-limit COMPARTIDO (Redis) anti fuerza-bruta — 10/min/IP. Complementa
    // el limiter in-memory del middleware (per-proceso).
    const rl = await redisRateLimit('login', clientIp(request), 10, 60);
    if (!rl.success) {
      return Response.json({ error: 'Demasiados intentos. Espera un momento.' }, { status: 429 });
    }

    const { email, password } = await request.json();
    if (!email || !password) {
      return Response.json({ error: 'Email y contraseña requeridos' }, { status: 400 });
    }

    const ua = request.headers.get('user-agent') || null;
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

    const result = await loginUser(email, password, { userAgent: ua, ip });

    if (result.error) {
      // NEEDS_RESET → usuario migrado de Supabase sin password local
      if (result.error.code === 'NEEDS_RESET') {
        return Response.json(
          { error: result.error.message, needsReset: true },
          { status: 409 },
        );
      }
      if (result.error.code === 'LOCKED') {
        return Response.json({ error: result.error.message }, { status: 423 });
      }
      // INVALID_CREDENTIALS y demás → 401 genérico (no revelar detalle)
      return Response.json({ error: 'Email o contraseña incorrectos' }, { status: 401 });
    }

    return Response.json({ success: true, user: result.user });
  } catch (error) {
    console.error('[Login]', error.message);
    return Response.json({ error: 'Error al iniciar sesión' }, { status: 500 });
  }
}
