-- =============================================================================
-- BASEBALL MODULE — Supabase migration
-- Run once at: https://supabase.com/dashboard/project/fdgxpznafsmhnuxjmcgd/sql/new
-- =============================================================================

-- Fixtures cache (1 entry per date)
CREATE TABLE IF NOT EXISTS public.baseball_fixtures_cache (
  date DATE PRIMARY KEY,
  fixtures JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Match analysis (per fixture)
CREATE TABLE IF NOT EXISTS public.baseball_match_analysis (
  fixture_id BIGINT PRIMARY KEY,
  date DATE NOT NULL,
  league_id INT,
  league_name TEXT,
  country TEXT,
  home_team_id BIGINT,
  away_team_id BIGINT,
  home_team TEXT,
  away_team TEXT,
  status TEXT,
  start_time TIMESTAMPTZ,
  scores JSONB,             -- { home: {total, hits, errors, innings:[{number,score}...]}, away: {...} }
  analysis JSONB,           -- { homeStats, awayStats, h2h, pitcherMatchup, parkFactor, ... }
  odds JSONB,               -- raw odds from API (multi-bookmaker)
  best_odds JSONB,          -- selected best odds per market
  probabilities JSONB,      -- { homeWin, awayWin, totalRuns:{over,under,line}, runLine:{...}, f5:{...}, ... }
  combinada JSONB,          -- top picks with combined odds
  data_quality JSONB,       -- { hasOdds, hasH2H, hasStats, hasPitcher, score 0-100 }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_baseball_analysis_date ON public.baseball_match_analysis(date);
CREATE INDEX IF NOT EXISTS idx_baseball_analysis_league ON public.baseball_match_analysis(league_id);
CREATE INDEX IF NOT EXISTS idx_baseball_analysis_status ON public.baseball_match_analysis(status);

-- Live game state (for in-progress games)
CREATE TABLE IF NOT EXISTS public.baseball_match_results (
  fixture_id BIGINT PRIMARY KEY,
  league_id INT,
  date DATE,
  status TEXT,
  inning INT,
  inning_half TEXT,           -- 'top' | 'bottom'
  home_score INT,
  away_score INT,
  home_hits INT,
  away_hits INT,
  home_errors INT,
  away_errors INT,
  innings JSONB,              -- per-inning breakdown
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_baseball_results_date ON public.baseball_match_results(date);

-- Standings cache (1 entry per league+season)
CREATE TABLE IF NOT EXISTS public.baseball_standings_cache (
  league_id INT,
  season INT,
  standings JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, season)
);

-- Schedule (mirrors match_schedule for live cron triggers)
CREATE TABLE IF NOT EXISTS public.baseball_match_schedule (
  date DATE PRIMARY KEY,
  schedule JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API quota tracking (separate from football)
CREATE TABLE IF NOT EXISTS public.baseball_api_calls (
  date DATE PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user hidden baseball games
CREATE TABLE IF NOT EXISTS public.baseball_user_hidden (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fixture_id BIGINT NOT NULL,
  date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fixture_id)
);
CREATE INDEX IF NOT EXISTS idx_baseball_hidden_user_date ON public.baseball_user_hidden(user_id, date);

-- Per-user baseball favorites
CREATE TABLE IF NOT EXISTS public.baseball_user_favorites (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fixture_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fixture_id)
);

-- =============================================================================
-- CALIBRATION SYSTEM (mirrors football match_predictions)
-- =============================================================================

-- Predictions: each row = one analyzed game with all predicted probabilities
-- and actual outcomes (filled in after game ends). Used by build-calibration.
CREATE TABLE IF NOT EXISTS public.baseball_match_predictions (
  fixture_id BIGINT PRIMARY KEY,
  date DATE NOT NULL,
  league_id INT,
  home_team_id BIGINT,
  away_team_id BIGINT,

  -- Predicted probabilities (integers 0-100)
  p_home_win INT,
  p_away_win INT,
  p_total_over_75 INT,
  p_total_over_85 INT,
  p_total_over_95 INT,
  p_total_over_105 INT,
  p_run_line_home_minus_15 INT,
  p_run_line_away_minus_15 INT,
  p_f5_home_win INT,
  p_f5_away_win INT,
  p_f5_over_45 INT,
  p_f5_over_55 INT,
  p_btts INT,
  p_team_total_home_over_35 INT,
  p_team_total_home_over_45 INT,
  p_team_total_away_over_35 INT,
  p_team_total_away_over_45 INT,
  expected_home_runs FLOAT,
  expected_away_runs FLOAT,

  -- Actual outcomes (filled by baseball/finalize cron)
  actual_home_score INT,
  actual_away_score INT,
  actual_result CHAR(1),         -- 'H' | 'A'
  actual_total_runs INT,
  actual_run_diff INT,           -- home - away
  actual_f5_home_score INT,
  actual_f5_away_score INT,
  actual_f5_total INT,
  actual_btts BOOLEAN,
  actual_status TEXT,

  -- Meta
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_baseball_predictions_date ON public.baseball_match_predictions(date);
CREATE INDEX IF NOT EXISTS idx_baseball_predictions_finalized ON public.baseball_match_predictions(finalized_at);

ALTER TABLE public.baseball_match_predictions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role all baseball_predictions" ON public.baseball_match_predictions;
CREATE POLICY "service role all baseball_predictions" ON public.baseball_match_predictions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public read baseball_predictions" ON public.baseball_match_predictions;
CREATE POLICY "public read baseball_predictions" ON public.baseball_match_predictions FOR SELECT USING (true);

-- RLS policies
ALTER TABLE public.baseball_fixtures_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseball_match_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseball_match_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseball_standings_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseball_match_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseball_api_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseball_user_hidden ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseball_user_favorites ENABLE ROW LEVEL SECURITY;

-- Service role full access
DROP POLICY IF EXISTS "service role all baseball_fixtures_cache" ON public.baseball_fixtures_cache;
CREATE POLICY "service role all baseball_fixtures_cache" ON public.baseball_fixtures_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service role all baseball_match_analysis" ON public.baseball_match_analysis;
CREATE POLICY "service role all baseball_match_analysis" ON public.baseball_match_analysis FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service role all baseball_match_results" ON public.baseball_match_results;
CREATE POLICY "service role all baseball_match_results" ON public.baseball_match_results FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service role all baseball_standings" ON public.baseball_standings_cache;
CREATE POLICY "service role all baseball_standings" ON public.baseball_standings_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service role all baseball_schedule" ON public.baseball_match_schedule;
CREATE POLICY "service role all baseball_schedule" ON public.baseball_match_schedule FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service role all baseball_api_calls" ON public.baseball_api_calls;
CREATE POLICY "service role all baseball_api_calls" ON public.baseball_api_calls FOR ALL TO service_role USING (true) WITH CHECK (true);

-- User-scoped policies for hidden / favorites
DROP POLICY IF EXISTS "users manage own baseball hidden" ON public.baseball_user_hidden;
CREATE POLICY "users manage own baseball hidden" ON public.baseball_user_hidden FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "service role all baseball_hidden" ON public.baseball_user_hidden;
CREATE POLICY "service role all baseball_hidden" ON public.baseball_user_hidden FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "users manage own baseball favorites" ON public.baseball_user_favorites;
CREATE POLICY "users manage own baseball favorites" ON public.baseball_user_favorites FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "service role all baseball_favs" ON public.baseball_user_favorites;
CREATE POLICY "service role all baseball_favs" ON public.baseball_user_favorites FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Public read (so anon dashboard can show fixtures + analyses)
DROP POLICY IF EXISTS "public read baseball_fixtures_cache" ON public.baseball_fixtures_cache;
CREATE POLICY "public read baseball_fixtures_cache" ON public.baseball_fixtures_cache FOR SELECT USING (true);
DROP POLICY IF EXISTS "public read baseball_match_analysis" ON public.baseball_match_analysis;
CREATE POLICY "public read baseball_match_analysis" ON public.baseball_match_analysis FOR SELECT USING (true);
DROP POLICY IF EXISTS "public read baseball_match_results" ON public.baseball_match_results;
CREATE POLICY "public read baseball_match_results" ON public.baseball_match_results FOR SELECT USING (true);
DROP POLICY IF EXISTS "public read baseball_standings" ON public.baseball_standings_cache;
CREATE POLICY "public read baseball_standings" ON public.baseball_standings_cache FOR SELECT USING (true);
