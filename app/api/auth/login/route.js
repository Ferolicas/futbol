// Login — auth nativo PG VPS (Fase 2.5 cerrada).
// loginUser de lib/auth-pg.js: valida bcrypt, maneja lockout por intentos
// fallidos, crea sesión (cookie JWT httpOnly). Reemplaza el login client-side
// que antes hacía supabase.auth.signInWithPassword en el browser.
import { createAuthenticatedSession, createEmailVerifyToken, loginUser } from '../../../../lib/auth-pg';
import { createAdminMfaChallenge, clearAdminMfaChallenge } from '../../../../lib/auth-mfa';
import { pgQuery } from '../../../../lib/db';
import { sendAdminLoginCode, sendEmailVerificationEmail } from '../../../../lib/email';
import { redisRateLimit, clientIp } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    // A2: rate-limit COMPARTIDO (Redis) anti fuerza-bruta — 10/min/IP. Complementa
    // el limiter in-memory del middleware (per-proceso).
    const rl = await redisRateLimit('login', clientIp(request), 10, 60, { failClosed: true });
    if (!rl.success) {
      return Response.json(
        { error: rl.available ? 'Demasiados intentos. Espera un momento.' : 'Servicio temporalmente no disponible.' },
        { status: rl.available ? 429 : 503, headers: { 'Retry-After': '60' } },
      );
    }

    const body = await request.json().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password || email.length > 254 || password.length > 256) {
      return Response.json({ error: 'Email y contraseña requeridos' }, { status: 400 });
    }

    const ua = request.headers.get('user-agent') || null;
    const ip = clientIp(request);

    const result = await loginUser(email, password, { userAgent: ua, ip, deferSession: true });

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
      if (result.error.code === 'EMAIL_UNVERIFIED') {
        const verifyLimit = await redisRateLimit('verify-email-send', result.error.userId, 3, 60 * 60, { failClosed: true });
        let delivered = false;
        if (verifyLimit.success) {
          try {
            const token = await createEmailVerifyToken(result.error.userId);
            await sendEmailVerificationEmail({
              to: result.error.email,
              name: result.error.displayName,
              token,
            });
            delivered = true;
          } catch (mailError) {
            console.error('[Login] verification email failed:', mailError.message);
          }
        }
        return Response.json({
          error: delivered
            ? 'Debes verificar tu correo. Te enviamos un enlace nuevo.'
            : 'Debes verificar tu correo. No pudimos enviar otro enlace ahora; inténtalo de nuevo más tarde.',
          verificationRequired: true,
        }, { status: delivered ? 403 : 503 });
      }
      // INVALID_CREDENTIALS y demás → 401 genérico (no revelar detalle)
      return Response.json({ error: 'Email o contraseña incorrectos' }, { status: 401 });
    }

    const profileResult = await pgQuery(
      `SELECT role, COALESCE(name, $2) AS name FROM public.user_profiles WHERE id = $1 LIMIT 1`,
      [result.user.id, result.user.displayName || result.user.email],
    );
    const profile = profileResult.rows[0] || { role: 'user', name: result.user.displayName };
    if (['admin', 'owner'].includes(profile.role)) {
      await clearAdminMfaChallenge();
      const code = await createAdminMfaChallenge(result.user.id);
      try {
        await sendAdminLoginCode({ to: result.user.email, name: profile.name, code });
      } catch (mailError) {
        await clearAdminMfaChallenge();
        console.error('[Login] admin MFA email failed:', mailError.message);
        return Response.json({ error: 'No pudimos enviar el código de seguridad.' }, { status: 503 });
      }
      return Response.json({ mfaRequired: true }, { status: 202 });
    }

    await createAuthenticatedSession(result.user.id, { userAgent: ua, ip });
    return Response.json({ success: true, user: result.user });
  } catch (error) {
    console.error('[Login]', error.message);
    return Response.json({ error: 'Error al iniciar sesión' }, { status: 500 });
  }
}
