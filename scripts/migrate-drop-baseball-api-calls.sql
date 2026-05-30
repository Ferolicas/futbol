-- Drop baseball_api_calls table (purge api-sports baseball quota tracker).
--
-- Contexto: baseball migrado a MLB Stats API (gratuita, sin cupo). La tabla
-- `baseball_api_calls` solo registraba el consumo diario contra v1.baseball.
-- api-sports.io, fuente ya eliminada del backend. Sin tabla nadie escribe ni
-- lee → se puede dropear sin afectar nada.
--
-- Ejecutar contra el VPS Postgres una sola vez:
--   PGPASSWORD='Pump0517*' psql -h 127.0.0.1 -p 5432 -U cfanalisis -d cfanalisis \
--     -f scripts/migrate-drop-baseball-api-calls.sql

BEGIN;

-- Doble verificación: solo dropear si la tabla efectivamente existe.
DROP TABLE IF EXISTS public.baseball_api_calls;

COMMIT;

-- Verificación manual post-migración:
--   SELECT to_regclass('public.baseball_api_calls') IS NULL AS dropped;  -- t
