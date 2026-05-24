-- ─────────────────────────────────────────────────────────────────────────
-- Migration: auth nativo en Postgres VPS — Fase 2.5
-- Reemplaza Supabase Auth con bcryptjs + JWT cookies + tabla auth_sessions.
--
-- Estrategia de IDs:
--   user_profiles.id ya usa el UUID que Supabase Auth generó para cada
--   usuario. Conservamos esos IDs en la nueva tabla `users` para que ningun
--   relacion existente se rompa (push_subscriptions, user_favorites, etc.).
--
-- Run on PG VPS:
--   PGPASSWORD='Pump0517*' psql -h 127.0.0.1 -p 6432 -U cfanalisis \
--     -d cfanalisis -f scripts/migrate-auth.sql
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Extension para gen_random_uuid() (Postgres 13+ built-in)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Tabla principal de usuarios (auth)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,          -- nullable: si NULL, el user fue migrado de
                               -- Supabase y debe usar "olvidé mi contraseña"
                               -- en el primer login.
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_verification_token TEXT,
  email_verification_expires TIMESTAMPTZ,
  password_reset_token TEXT,
  password_reset_expires TIMESTAMPTZ,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Metadata opcional
  display_name TEXT,
  avatar_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (password_reset_token) WHERE password_reset_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users (email_verification_token) WHERE email_verification_token IS NOT NULL;

-- 3. Tabla de sesiones (JWT alternative — sessions DB-backed para poder
--    revocar instantaneamente cuando user hace logout en otro device).
--    El cookie almacena solo session_id; el server valida contra esta tabla.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent TEXT,
  ip INET
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions (expires_at);

-- 4. Trigger para actualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 5. (Opcional) FK desde user_profiles a users para integridad referencial.
--    Solo añadir si los IDs ya estan migrados — sino fallará por orphans.
--    Descomentar tras migrate-supabase-users-to-pg.js:
-- ALTER TABLE user_profiles
--   ADD CONSTRAINT user_profiles_id_fkey
--   FOREIGN KEY (id) REFERENCES users(id) ON DELETE CASCADE;

-- 6. View de utilidad — combina users + user_profiles para queries comunes
CREATE OR REPLACE VIEW v_user_full AS
SELECT
  u.id, u.email, u.email_verified, u.created_at AS auth_created_at,
  u.locked_until,
  p.name, p.role, p.plan, p.subscription_status, p.stripe_customer_id,
  p.timezone, p.custom_league_ids
FROM users u
LEFT JOIN user_profiles p ON p.id = u.id;

-- 7. Conteo de filas
SELECT
  (SELECT COUNT(*) FROM users) AS users_count,
  (SELECT COUNT(*) FROM auth_sessions) AS sessions_count,
  (SELECT COUNT(*) FROM user_profiles) AS profiles_count;
