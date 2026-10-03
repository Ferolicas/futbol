// Registro de usuario — auth nativo PG VPS (Fase 2.5 cerrada).
// Antes usaba supabaseAdmin.auth.admin.createUser. Ahora signupUser de
// lib/auth-pg.js: bcrypt + tabla `users`; la sesión nace tras verificar email.
import { signupUser } from '../../../lib/auth-pg';
import { sendEmailVerificationEmail } from '../../../lib/email';
import { redisRateLimit, clientIp } from '../../../lib/ratelimit-redis';
import { validateDisplayName } from '../../../lib/user-profile-validation';
import {
  LEGAL_DOCUMENT_VERSION,
  prepareLegalEvidence,
} from '../../../lib/legal';
import { normalizePurchaseIntent, normalizePurchasePlan, purchaseRoute } from '../../../lib/purchase-flow';

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

    const body = await request.json().catch(() => null);
    const { name, email, password, acceptAll, marketingConsent, legalVersion, source, plan, intent } = body || {};

    if (!name || !email || !password) {
      return Response.json({ error: 'Nombre, email y contrasena son obligatorios' }, { status: 400 });
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
    const ip = clientIp(request);
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
    const verifiedPlan = normalizePurchasePlan(plan);
    const verifiedIntent = normalizePurchaseIntent(intent);
    const continuePath = purchaseRoute('/verify-email', 'plan', verifiedPlan, verifiedIntent);
    try {
      await sendEmailVerificationEmail({
        to: emailLower,
        name: validName.name,
        token: result.emailVerifyToken,
        continuePath,
      });
    } catch (mailError) {
      console.error('[Register] verification email failed:', mailError.message);
      return Response.json({
        error: 'La cuenta fue creada, pero no pudimos enviar el correo. Inicia sesión para solicitar otro enlace.',
        accountCreated: true,
      }, { status: 503 });
    }

    return Response.json({ success: true, userId, verificationRequired: true });
  } catch (error) {
    console.error('[Register] Error:', error.message, error.stack?.split('\n')[1]);
    return Response.json({ error: 'Error al registrar usuario' }, { status: 500 });
  }
}
