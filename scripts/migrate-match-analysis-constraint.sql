-- ─────────────────────────────────────────────────────────────────────────
-- match_analysis: garantizar UNIQUE(fixture_id, date) + columna live_stats
--
-- POR QUÉ: el job futbol-analyze-batch usa
--   supabaseAdmin.from('match_analysis').upsert(..., { onConflict: 'fixture_id,date' })
-- que pgAdmin traduce a `ON CONFLICT (fixture_id, date) DO UPDATE`. Si esa
-- UNIQUE composite NO existe, Postgres responde:
--   "there is no unique or exclusion constraint matching the ON CONFLICT spec"
-- y el upsert FALLA. cacheAnalysis lo silenciaba con .catch() → la tabla
-- quedaba en 0 filas pese a que el job reportaba éxito.
--
-- Este script es idempotente:
--   - Crea la tabla si no existe (esquema mínimo compatible).
--   - Añade la constraint UNIQUE si no existe (vía DO block — IF NOT EXISTS
--     no aplica a constraints en Postgres < 15 sin extensiones).
--   - Añade live_stats si no existe.
--   - Crea índices útiles.
--
-- Correr:
--   PGPASSWORD='Pump0517*' psql -h 127.0.0.1 -p 6432 -U cfanalisis -d cfanalisis \
--     -f scripts/migrate-match-analysis-constraint.sql
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Tabla mínima (no-op si ya existe)
CREATE TABLE IF NOT EXISTS public.match_analysis (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fixture_id      integer NOT NULL,
  date            date NOT NULL,
  analysis        jsonb NOT NULL,
  odds            jsonb,
  combinada       jsonb,
  probabilities   jsonb,
  data_quality    text DEFAULT 'good',
  cache_version   integer DEFAULT 9,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 2) live_stats (idempotente)
ALTER TABLE public.match_analysis
  ADD COLUMN IF NOT EXISTS live_stats jsonb;

-- 3) UNIQUE (fixture_id, date) — necesaria para el onConflict del upsert.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.match_analysis'::regclass
      AND contype  = 'u'
      AND conkey   = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid='public.match_analysis'::regclass AND attname='fixture_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid='public.match_analysis'::regclass AND attname='date')
      ]
  ) THEN
    ALTER TABLE public.match_analysis
      ADD CONSTRAINT match_analysis_fixture_date_key UNIQUE (fixture_id, date);
  END IF;
END$$;

-- 4) Índices útiles
CREATE INDEX IF NOT EXISTS match_analysis_date_idx       ON public.match_analysis (date);
CREATE INDEX IF NOT EXISTS match_analysis_fixture_id_idx ON public.match_analysis (fixture_id);

-- 5) Sanity check
SELECT
  CASE WHEN to_regclass('public.match_analysis') IS NOT NULL THEN 'OK tabla'         ELSE 'MISSING tabla' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.match_analysis'::regclass
      AND conname='match_analysis_fixture_date_key'
  ) THEN 'OK UNIQUE(fixture_id,date)' ELSE 'MISSING UNIQUE' END AS constraint_check,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='match_analysis' AND column_name='live_stats'
  ) THEN 'OK live_stats' ELSE 'MISSING live_stats' END AS column_check,
  (SELECT count(*) FROM public.match_analysis) AS rows;
