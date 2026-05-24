-- ─────────────────────────────────────────────────────────────────────────
-- push_subscriptions — versión Postgres PURA (sin auth.users FK, sin RLS).
--
-- La única definición que existía estaba en supabase-schema.sql /
-- migrate-new-tables.sql con `REFERENCES auth.users(id)` + RLS — incompatibles
-- con el VPS (no existe el schema auth ni service_role). Por eso la tabla
-- nunca se creó en el VPS y las suscripciones push no se guardaban → no
-- llegaban notificaciones.
--
-- UNIQUE(user_id) es OBLIGATORIO: el endpoint /api/push/subscribe hace
--   upsert(..., { onConflict: 'user_id' })  → necesita esa constraint.
--
-- `subscription` es jsonb y guarda un ARRAY de suscripciones (una por
-- dispositivo del usuario) — el endpoint deduplica por endpoint.
--
-- Correr en el VPS:
--   PGPASSWORD='Pump0517*' psql -h 127.0.0.1 -p 6432 -U cfanalisis \
--     -d cfanalisis -f scripts/migrate-push-subscriptions.sql
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid NOT NULL,
  subscription  jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON public.push_subscriptions (user_id);

-- Sanity check
SELECT
  CASE WHEN to_regclass('public.push_subscriptions') IS NOT NULL
       THEN 'OK push_subscriptions existe' ELSE 'MISSING' END AS estado,
  (SELECT count(*) FROM public.push_subscriptions) AS filas;
