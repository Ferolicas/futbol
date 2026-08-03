BEGIN;

ALTER TABLE public.baseball_match_results
  ADD COLUMN IF NOT EXISTS home_stats JSONB,
  ADD COLUMN IF NOT EXISTS away_stats JSONB;

COMMENT ON COLUMN public.baseball_match_results.home_stats IS
  'Boxscore oficial MLB del equipo local: hits, HR, 2B, 3B, BB, K, LOB, TB y métricas disponibles.';
COMMENT ON COLUMN public.baseball_match_results.away_stats IS
  'Boxscore oficial MLB del equipo visitante: hits, HR, 2B, 3B, BB, K, LOB, TB y métricas disponibles.';

COMMIT;
