// ──────────────────────────────────────────────────────────────────────────
// Auth nativo en Postgres VPS — Fase 2.5
//
// Reemplaza @supabase/ssr con:
//   - bcryptjs para password hashing
//   - JWT cookies (lib/auth-session.js) para session token
//   - Tabla `users` y `auth_sessions` en PG VPS
//
// API publica:
//   - signupUser(email, password, options) → { user, sessionId } | { error }
//   - loginUser(email, password) → { user, sessionId } | { error }
//   - logoutUser(sessionId) → boolean
//   - getCurrentUser() → user | null   (lee la cookie)
//   - requireUser() → user (lanza si null)
//   - createPasswordResetToken(email) → token | null
//   - consumePasswordResetToken(token, newPassword) → { ok } | { error }
//   - createEmailVerifyToken(userId) → token
//   - verifyEmail(token) → { ok } | { error }
//
// Switch entre Supabase y este PG auth: env var AUTH_PROVIDER=pg activa
// las funciones de aqui. Por defecto sigue siendo Supabase.
// ──────────────────────────────────────────────────────────────────────────

import bcrypt from 'bcryptjs';
import { pgQuery } from './db';
import {
  signSessionJWT,
  verifySessionJWT,
  setSessionCookie,
  getSessionCookie,
  clearSessionCookie,
  COOKIE_MAX_AGE,
} from './auth-session';
import { randomBytes, createHash } from 'crypto';

const BCRYPT_ROUNDS = 10;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const TOKEN_BYTES = 32;
const RESET_TOKEN_EXPIRY_MIN = 60;
const VERIFY_TOKEN_EXPIRY_HOURS = 24 * 7;  // 1 semana

// ── helpers ────────────────────────────────────────────────────────────────

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

function hashToken(token) {
  // Tokens en DB son hashed con SHA-256 — protege contra exposicion en backups.
  // El token que se envia al usuario por email es el plain. Al recibirlo,
  // hasheamos y comparamos.
  return createHash('sha256').update(token).digest('hex');
}

// ── signup ─────────────────────────────────────────────────────────────────

/**
 * Crea un nuevo usuario + perfil + sesion inmediata.
 * Devuelve { user, sessionId } o { error: { code, message } }.
 */
export async function signupUser(email, password, options = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password) {
    return { error: { code: 'INVALID_INPUT', message: 'Email y password requeridos' } };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    return { error: { code: 'INVALID_EMAIL', message: 'Email no valido' } };
  }
  if (password.length < 8) {
    return { error: { code: 'WEAK_PASSWORD', message: 'Password debe tener al menos 8 caracteres' } };
  }

  // Check email duplicado
  const exists = await pgQuery('SELECT id FROM public.users WHERE LOWER(email) = $1', [normalizedEmail]);
  if (exists.rows.length > 0) {
    return { error: { code: 'EMAIL_TAKEN', message: 'Email ya registrado' } };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const emailVerifyToken = generateToken();
  const emailVerifyTokenHash = hashToken(emailVerifyToken);
  const verifyExpiresAt = new Date(Date.now() + VERIFY_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  // Insert user + perfil en una transaccion
  const userResult = await pgQuery(
    `INSERT INTO public.users (email, password_hash, email_verification_token, email_verification_expires, display_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, email_verified, created_at`,
    [normalizedEmail, passwordHash, emailVerifyTokenHash, verifyExpiresAt, options.displayName || null],
  );
  const user = userResult.rows[0];

  // Crear perfil minimal — los demas campos se llenan con el flow de pagos
  await pgQuery(
    `INSERT INTO user_profiles (id, email, name, role, plan, subscription_status, created_at)
     VALUES ($1, $2, $3, 'user', NULL, 'inactive', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [user.id, normalizedEmail, options.displayName || null],
  );

  // Crear sesion inmediata
  const sessionId = await createSession(user.id, options.userAgent, options.ip);
  const jwt = await signSessionJWT(user.id, sessionId);
  setSessionCookie(jwt);

  return {
    user: { id: user.id, email: user.email, emailVerified: user.email_verified },
    sessionId,
    // El plain token se devuelve al caller para que envie email de verificacion
    emailVerifyToken,
  };
}

// ── login ──────────────────────────────────────────────────────────────────

export async function loginUser(email, password, options = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password) {
    return { error: { code: 'INVALID_INPUT', message: 'Email y password requeridos' } };
  }

  const r = await pgQuery(
    `SELECT id, email, password_hash, email_verified, failed_login_attempts, locked_until
     FROM public.users
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [normalizedEmail],
  );
  const user = r.rows[0];
  if (!user) {
    // No revelamos que el email no existe — mismo error que password mala
    return { error: { code: 'INVALID_CREDENTIALS', message: 'Email o password incorrectos' } };
  }

  // Lock check
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { error: { code: 'LOCKED', message: `Cuenta bloqueada hasta ${user.locked_until}` } };
  }

  // Si password_hash es NULL → usuario migrado de Supabase sin contraseña
  // local. Forzar reset via "olvidé contraseña".
  if (!user.password_hash) {
    return { error: { code: 'NEEDS_RESET', message: 'Usa "olvide mi contrase&ntilde;a" la primera vez' } };
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    // Incrementar contador de fallos + bloquear si excede
    const newAttempts = (user.failed_login_attempts || 0) + 1;
    const updates = ['failed_login_attempts = $1'];
    const params = [newAttempts];
    if (newAttempts >= MAX_FAILED_ATTEMPTS) {
      updates.push('locked_until = $2');
      params.push(new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000));
    }
    params.push(user.id);
    await pgQuery(`UPDATE public.users SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    return { error: { code: 'INVALID_CREDENTIALS', message: 'Email o password incorrectos' } };
  }

  // Resetear contador de fallos en login exitoso
  await pgQuery(
    `UPDATE public.users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
    [user.id],
  );

  const sessionId = await createSession(user.id, options.userAgent, options.ip);
  const jwt = await signSessionJWT(user.id, sessionId);
  setSessionCookie(jwt);

  return {
    user: { id: user.id, email: user.email, emailVerified: user.email_verified },
    sessionId,
  };
}

// ── logout ─────────────────────────────────────────────────────────────────

export async function logoutUser() {
  const token = getSessionCookie();
  if (token) {
    const payload = await verifySessionJWT(token);
    if (payload?.sid) {
      await pgQuery('DELETE FROM public.auth_sessions WHERE id = $1', [payload.sid]).catch(() => {});
    }
  }
  clearSessionCookie();
  return true;
}

// ── current user / require user ────────────────────────────────────────────

/**
 * Lee la cookie de sesion, valida JWT, valida session_id en DB.
 * Devuelve el user object o null si no hay sesion valida.
 */
export async function getCurrentUser() {
  const token = getSessionCookie();
  if (!token) return null;
  const payload = await verifySessionJWT(token);
  if (!payload?.uid || !payload?.sid) return null;

  const r = await pgQuery(
    `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.email_verified, u.display_name
     FROM public.auth_sessions s
     JOIN public.users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.user_id = $2 AND s.expires_at > NOW()
     LIMIT 1`,
    [payload.sid, payload.uid],
  );
  if (r.rows.length === 0) {
    // Sesion borrada (revoked) o expirada
    clearSessionCookie();
    return null;
  }
  const row = r.rows[0];

  // Bump last_seen para tracking — fire-and-forget
  pgQuery('UPDATE public.auth_sessions SET last_seen = NOW() WHERE id = $1', [payload.sid]).catch(() => {});

  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    displayName: row.display_name,
  };
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error('UNAUTHORIZED');
  return user;
}

// ── sessions ───────────────────────────────────────────────────────────────

async function createSession(userId, userAgent, ip) {
  const expiresAt = new Date(Date.now() + COOKIE_MAX_AGE * 1000);
  const r = await pgQuery(
    `INSERT INTO public.auth_sessions (user_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, expiresAt, userAgent || null, ip || null],
  );
  return r.rows[0].id;
}

export async function listSessions(userId) {
  const r = await pgQuery(
    `SELECT id, created_at, last_seen, expires_at, user_agent, ip
     FROM public.auth_sessions
     WHERE user_id = $1 AND expires_at > NOW()
     ORDER BY last_seen DESC`,
    [userId],
  );
  return r.rows;
}

export async function revokeSession(userId, sessionId) {
  await pgQuery('DELETE FROM public.auth_sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]);
}

export async function revokeAllSessionsExcept(userId, keepSessionId) {
  await pgQuery(
    'DELETE FROM public.auth_sessions WHERE user_id = $1 AND id <> $2',
    [userId, keepSessionId],
  );
}

// ── password reset ─────────────────────────────────────────────────────────

/**
 * Genera un token de reset. Lo guarda HASHED en DB y devuelve el PLAIN para
 * que el caller lo envie por email.
 *
 * Por seguridad NO revela si el email existe — siempre devuelve un token
 * (incluso si el user no existe). Solo cuando consumePasswordResetToken
 * encuentra el match real se efectua el cambio.
 *
 * Caller debe enviar el email solo si {tokenForEmail, userId} estan presentes.
 */
export async function createPasswordResetToken(email) {
  const normalizedEmail = normalizeEmail(email);
  const r = await pgQuery('SELECT id FROM public.users WHERE LOWER(email) = $1', [normalizedEmail]);
  if (r.rows.length === 0) {
    // Devolver dummy token para no revelar
    return { tokenForEmail: null, userId: null };
  }
  const userId = r.rows[0].id;
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MIN * 60 * 1000);

  await pgQuery(
    `UPDATE public.users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3`,
    [tokenHash, expiresAt, userId],
  );

  return { tokenForEmail: token, userId };
}

export async function consumePasswordResetToken(token, newPassword) {
  if (!token || !newPassword) {
    return { error: { code: 'INVALID_INPUT', message: 'Token y nueva password requeridos' } };
  }
  if (newPassword.length < 8) {
    return { error: { code: 'WEAK_PASSWORD', message: 'Password debe tener al menos 8 caracteres' } };
  }

  const tokenHash = hashToken(token);
  const r = await pgQuery(
    `SELECT id FROM public.users
     WHERE password_reset_token = $1
       AND password_reset_expires > NOW()
     LIMIT 1`,
    [tokenHash],
  );
  if (r.rows.length === 0) {
    return { error: { code: 'INVALID_TOKEN', message: 'Token invalido o expirado' } };
  }
  const userId = r.rows[0].id;

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await pgQuery(
    `UPDATE public.users SET
       password_hash = $1,
       password_reset_token = NULL,
       password_reset_expires = NULL,
       failed_login_attempts = 0,
       locked_until = NULL
     WHERE id = $2`,
    [passwordHash, userId],
  );

  // Revocar todas las sesiones del user — fuerza re-login en otros devices
  await pgQuery('DELETE FROM public.auth_sessions WHERE user_id = $1', [userId]);

  return { ok: true, userId };
}

// ── email verification ─────────────────────────────────────────────────────

export async function createEmailVerifyToken(userId) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
  await pgQuery(
    `UPDATE public.users SET email_verification_token = $1, email_verification_expires = $2 WHERE id = $3`,
    [tokenHash, expiresAt, userId],
  );
  return token;
}

export async function verifyEmail(token) {
  if (!token) return { error: { code: 'INVALID_INPUT', message: 'Token requerido' } };
  const tokenHash = hashToken(token);
  const r = await pgQuery(
    `UPDATE public.users
     SET email_verified = TRUE,
         email_verification_token = NULL,
         email_verification_expires = NULL
     WHERE email_verification_token = $1
       AND email_verification_expires > NOW()
     RETURNING id`,
    [tokenHash],
  );
  if (r.rows.length === 0) {
    return { error: { code: 'INVALID_TOKEN', message: 'Token invalido o expirado' } };
  }
  return { ok: true, userId: r.rows[0].id };
}

// ── change password (logged-in flow) ──────────────────────────────────────

export async function changePassword(userId, oldPassword, newPassword) {
  if (newPassword.length < 8) {
    return { error: { code: 'WEAK_PASSWORD', message: 'Password debe tener al menos 8 caracteres' } };
  }
  const r = await pgQuery('SELECT password_hash FROM public.users WHERE id = $1', [userId]);
  if (r.rows.length === 0) return { error: { code: 'NOT_FOUND', message: 'User not found' } };

  const valid = await bcrypt.compare(oldPassword, r.rows[0].password_hash);
  if (!valid) return { error: { code: 'INVALID_OLD', message: 'Password actual incorrecto' } };

  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await pgQuery('UPDATE public.users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
  return { ok: true };
}

// ── cleanup (cron) ─────────────────────────────────────────────────────────

/** Limpia sesiones expiradas + tokens viejos. Run via cron diario. */
export async function cleanupExpiredAuth() {
  const sess = await pgQuery('DELETE FROM public.auth_sessions WHERE expires_at < NOW()');
  const resetTokens = await pgQuery(
    `UPDATE public.users SET password_reset_token = NULL, password_reset_expires = NULL
     WHERE password_reset_expires < NOW()`,
  );
  const verifyTokens = await pgQuery(
    `UPDATE public.users SET email_verification_token = NULL, email_verification_expires = NULL
     WHERE email_verification_expires < NOW() AND email_verified = FALSE`,
  );
  return {
    sessionsCleared: sess.rowCount,
    resetTokensCleared: resetTokens.rowCount,
    verifyTokensCleared: verifyTokens.rowCount,
  };
}
