-- CF Analisis — estado en vivo detallado de béisbol (conteo, corredores en
-- base). Migracion ADITIVA e idempotente.

BEGIN;

ALTER TABLE public.baseball_match_results
  ADD COLUMN IF NOT EXISTS outs smallint,
  ADD COLUMN IF NOT EXISTS balls smallint,
  ADD COLUMN IF NOT EXISTS strikes smallint,
  ADD COLUMN IF NOT EXISTS bases jsonb;

COMMIT;
