// Registro de usuario — auth nativo PG VPS (Fase 2.5 cerrada).
// Antes usaba supabaseAdmin.auth.admin.createUser. Ahora signupUser de
// lib/auth-pg.js: bcrypt + tabla `users` + sesión inmediata (cookie JWT).
import { signupUser } from '../../../lib/auth-pg';
import { sendWelcomeEmail } from '../../../lib/email';
import { redisRateLimit, clientIp } from '../../../lib/ratelimit-redis';
import { validateDisplayName } from '../../../lib/user-profile-validation';
import {
  LEGAL_DOCUMENT_VERSION,
  prepareLegalEvidence,
} from '../../../lib/legal';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    // A2: rate-limit compartido (Redis) — 5/min/IP anti abuso de registro.
    const rl = await redisRateLimit('register', clientIp(request), 5, 60, { failClosed: true });
    if (!rl.success) {
      return Response.json(
        { error: rl.available ? 'Demasiados intentos. Espera un momento.' : 'Servicio temporalmente no disponible.' },
        { status: rl.available ? 429 : 503, headers: { 'Retry-After': '60' } },
      );
    }

    const { name, email, password, acceptAll, marketingConsent, legalVersion, source } = await request.json();

    if (!name || !email || !password) {
      return Response.json({ error: 'Nombre, email y contrasena son obligatorios' }, { status: 400 });
    }
    if (password.length < 8) {
      return Response.json({ error: 'La contrasena debe tener al menos 8 caracteres' }, { status: 400 });
    }
    const validName = validateDisplayName(name);
    if (!validName.success) {
      return Response.json({ error: validName.error }, { status: 400 });
    }
    if (acceptAll !== true || legalVersion !== LEGAL_DOCUMENT_VERSION) {
      return Response.json({ error: 'Debes aceptar los documentos legales vigentes.' }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();
    const ua = request.headers.get('user-agent') || null;
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const registrationSource = source === 'mobile' ? 'registration-mobile' : 'registration-web';
    const legalEvidence = prepareLegalEvidence(request, registrationSource);
    const marketingEvidence = marketingConsent === true
      ? prepareLegalEvidence(request, registrationSource, 'marketing-consent')
      : null;

    // Cuenta, perfil y aceptación legal se confirman en una sola transacción;
    // la sesión solo nace después del COMMIT.
    const result = await signupUser(emailLower, password, {
      displayName: validName.name,
      userAgent: ua,
      ip,
      legalEvidence,
      marketingConsent: marketingConsent === true,
      marketingEvidence,
    });

    if (result.error) {
      if (result.error.code === 'EMAIL_TAKEN') {
        return Response.json({ error: 'Este email ya esta registrado' }, { status: 409 });
      }
      return Response.json({ error: result.error.message || 'Error al registrar usuario' }, { status: 400 });
    }

    const userId = result.user.id;

    // Welcome email (fire and forget). NO incluir password en claro en el email
    // ya no es necesario — el usuario la eligió. Mantenemos compat con la firma.
    sendWelcomeEmail({ to: emailLower, name: validName.name }).catch((e) =>
      console.error('[Register] Welcome email failed:', e.message)
    );

    return Response.json({ success: true, userId, message: 'Usuario registrado exitosamente' });
  } catch (error) {
    console.error('[Register] Error:', error.message, error.stack?.split('\n')[1]);
    return Response.json({ error: 'Error al registrar usuario' }, { status: 500 });
  }
}
