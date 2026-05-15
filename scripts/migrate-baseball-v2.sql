-- =============================================================================
-- BASEBALL v2 — añade cache_version a baseball_match_analysis
--
-- Necesario para invalidar análisis del esquema viejo cuando cambia la
-- estructura de probabilities (player markets, pitcher matchup, líneas
-- adaptativas). Mismo patron que match_analysis.cache_version en fútbol.
--
-- Ejecutar UNA VEZ:
--   psql "$DATABASE_URL" -f scripts/migrate-baseball-v2.sql
-- =============================================================================

ALTER TABLE public.baseball_match_analysis
  ADD COLUMN IF NOT EXISTS cache_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_baseball_analysis_cache_version
  ON public.baseball_match_analysis(cache_version);

COMMENT ON COLUMN public.baseball_match_analysis.cache_version
  IS 'Version del schema de analysis/probabilities. Filas con version <
      BASEBALL_MIN_CACHE_VERSION se re-analizan automaticamente al primer hit.';
