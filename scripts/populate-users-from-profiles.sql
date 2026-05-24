-- ─────────────────────────────────────────────────────────────────────────
-- Poblar la tabla auth `users` desde `user_profiles` (ya migrado al VPS).
--
-- Por qué SQL puro y NO migrate-supabase-users-to-pg.js:
--   user_profiles ya tiene id (UUID original de Supabase) + email + name de
--   los 63 usuarios. No hace falta llamar a la Supabase Auth API — derivamos
--   la tabla `users` directo de los perfiles ya migrados.
--
-- password_hash = NULL  → cada usuario debe usar "olvidé mi contraseña" la
--   primera vez (los hashes bcrypt de Supabase NO se pueden portar).
-- email_verified = TRUE → estaban verificados en Supabase.
--
-- Conserva los UUIDs → push_subscriptions, user_favorites, user_hidden,
-- combinadas, etc. siguen matcheando por user_id.
--
-- Idempotente: ON CONFLICT (id) DO NOTHING. Re-correrlo no pisa hashes ya
-- creados por usuarios que YA hicieron reset.
--
-- Correr:
--   eval "$PGCMD -f scripts/populate-users-from-profiles.sql"
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO users (id, email, password_hash, email_verified, display_name, created_at)
SELECT
  p.id,
  LOWER(p.email),
  NULL,                          -- sin password local → forzar reset 1ra vez
  TRUE,                          -- verificados en Supabase
  p.name,
  COALESCE(p.created_at, NOW())
FROM user_profiles p
WHERE p.email IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Conteo de control
SELECT
  (SELECT count(*) FROM user_profiles) AS perfiles,
  (SELECT count(*) FROM users)          AS users_auth,
  (SELECT count(*) FROM users WHERE password_hash IS NULL) AS pendientes_reset;
