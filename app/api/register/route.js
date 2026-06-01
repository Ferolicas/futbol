// Registro de usuario — auth nativo PG VPS (Fase 2.5 cerrada).
// Antes usaba supabaseAdmin.auth.admin.createUser. Ahora signupUser de
// lib/auth-pg.js: bcrypt + tabla `users` + sesión inmediata (cookie JWT).
import { signupUser } from '../../../lib/auth-pg';
import { supabaseAdmin } from '../../../lib/supabase';
import { sendWelcomeEmail } from '../../../lib/email';
import { redisRateLimit, clientIp } from '../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    // A2: rate-limit compartido (Redis) — 5/min/IP anti abuso de registro.
    const rl = await redisRateLimit('register', clientIp(request), 5, 60);
    if (!rl.success) {
      return Response.json({ error: 'Demasiados intentos. Espera un momento.' }, { status: 429 });
    }

    const { name, email, password, country, plan } = await request.json();

    if (!name || !email || !password) {
      return Response.json({ error: 'Nombre, email y contrasena son obligatorios' }, { status: 400 });
    }
    if (password.length < 8) {
      return Response.json({ error: 'La contrasena debe tener al menos 8 caracteres' }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();
    const ua = request.headers.get('user-agent') || null;
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

    // signupUser: crea users + user_profiles minimal + sesión (setea cookie).
    const result = await signupUser(emailLower, password, {
      displayName: name.trim(),
      userAgent: ua,
      ip,
    });

    if (result.error) {
      if (result.error.code === 'EMAIL_TAKEN') {
        return Response.json({ error: 'Este email ya esta registrado' }, { status: 409 });
      }
      return Response.json({ error: result.error.message || 'Error al registrar usuario' }, { status: 400 });
    }

    const userId = result.user.id;

    // Completar el perfil con country/plan (signupUser crea el perfil minimal).
    const { error: profileErr } = await supabaseAdmin.from('user_profiles').upsert({
      id: userId,
      email: emailLower,
      name: name.trim(),
      country: country || 'unknown',
      role: 'user',
      plan: plan || null,
      subscription_status: 'pending',
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (profileErr) console.error('[Register] profile:', profileErr.message);

    // Welcome email (fire and forget). NO incluir password en claro en el email
    // ya no es necesario — el usuario la eligió. Mantenemos compat con la firma.
    sendWelcomeEmail({ to: emailLower, name: name.trim(), password }).catch((e) =>
      console.error('[Register] Welcome email failed:', e.message)
    );

    return Response.json({ success: true, userId, message: 'Usuario registrado exitosamente' });
  } catch (error) {
    console.error('[Register] Error:', error.message, error.stack?.split('\n')[1]);
    return Response.json({ error: 'Error al registrar usuario' }, { status: 500 });
  }
}
