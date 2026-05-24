-- ============================================================
-- Migración Postgres pura — sin Supabase (sin RLS, sin auth.uid)
--
-- Ejecutar en el VPS contra tu Postgres (pgBouncer en 127.0.0.1:6432):
--   psql -h 127.0.0.1 -p 6432 -U <user> -d <db> -f migrate-tables-postgres.sql
--
-- Idempotente: usa CREATE TABLE IF NOT EXISTS y ALTER ... IF NOT EXISTS.
-- Puede correrse N veces sin efectos colaterales.
--
-- NOTA: el código actual referencia `combinadas` (no `combinadas_guardadas`)
-- en app/api/user/route.js. Si quieres renombrar, hay que cambiar también
-- esas queries. Si NO, deja el nombre `combinadas` como está aquí.
-- ============================================================

-- Extensión necesaria para gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- tickets — soporte/atención al cliente
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    text UNIQUE NOT NULL,
  user_id      uuid NOT NULL,
  user_name    text,
  user_email   text,
  message      text NOT NULL,
  status       text NOT NULL DEFAULT 'open',
  reply        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  replied_at   timestamptz
);

CREATE INDEX IF NOT EXISTS tickets_user_id_idx     ON public.tickets (user_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx      ON public.tickets (status);
CREATE INDEX IF NOT EXISTS tickets_created_at_idx  ON public.tickets (created_at DESC);

-- ============================================================
-- chat_messages — chat in-app usuario↔admin
-- ============================================================
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  user_name    text,
  user_email   text,
  message      text NOT NULL,
  sender       text NOT NULL DEFAULT 'user',  -- 'user' | 'admin'
  read         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_user_id_idx     ON public.chat_messages (user_id);
CREATE INDEX IF NOT EXISTS chat_messages_read_idx        ON public.chat_messages (read) WHERE read = false;
CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx  ON public.chat_messages (created_at DESC);

-- ============================================================
-- combinadas — combinadas que cada usuario guarda manualmente
-- (la "Combinada del Día" auto-generada vive en cron publish-combinada
--  y se guarda en Redis, no en esta tabla)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.combinadas (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL,
  name                  text,
  selections            jsonb NOT NULL DEFAULT '[]'::jsonb,
  combined_odd          double precision,
  combined_probability  double precision,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS combinadas_user_id_idx     ON public.combinadas (user_id);
CREATE INDEX IF NOT EXISTS combinadas_created_at_idx  ON public.combinadas (created_at DESC);

-- ============================================================
-- Sanity check — debería devolver 3 filas con "OK"
-- ============================================================
SELECT
  CASE WHEN to_regclass('public.tickets')        IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS tickets,
  CASE WHEN to_regclass('public.chat_messages')  IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS chat_messages,
  CASE WHEN to_regclass('public.combinadas')     IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS combinadas;
