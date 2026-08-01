-- Motores empíricos independientes: MLB, NBA y NFL.
-- No ejecutar automáticamente desde el build. En producción: backup primero.

BEGIN;

-- ---------------------------------------------------------------------------
-- Hechos de Baseball (separados del schema model de fútbol)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.baseball_engine_matches (
  fixture_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_fixture_id TEXT NOT NULL,
  competition_id TEXT,
  season TEXT,
  kickoff TIMESTAMPTZ NOT NULL,
  status TEXT,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  home_team TEXT,
  away_team TEXT,
  home_logo TEXT,
  away_logo TEXT,
  home_score NUMERIC,
  away_score NUMERIC,
  periods JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_baseball_engine_matches_time ON public.baseball_engine_matches(kickoff);
CREATE INDEX IF NOT EXISTS idx_baseball_engine_matches_provider ON public.baseball_engine_matches(provider,provider_fixture_id);

CREATE TABLE IF NOT EXISTS public.baseball_engine_team_stats (
  fixture_id TEXT NOT NULL REFERENCES public.baseball_engine_matches(fixture_id) ON DELETE CASCADE,
  kickoff TIMESTAMPTZ NOT NULL,
  team_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  competition_id TEXT,
  season TEXT,
  is_home BOOLEAN NOT NULL,
  score_for NUMERIC,
  score_against NUMERIC,
  period_scores JSONB NOT NULL DEFAULT '[]'::jsonb,
  period_scores_against JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  result CHAR(1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(fixture_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_baseball_engine_team_time ON public.baseball_engine_team_stats(team_id, kickoff DESC);
CREATE INDEX IF NOT EXISTS idx_baseball_engine_opp_time ON public.baseball_engine_team_stats(opponent_id, kickoff DESC);

CREATE TABLE IF NOT EXISTS public.baseball_engine_player_stats (
  fixture_id TEXT NOT NULL REFERENCES public.baseball_engine_matches(fixture_id) ON DELETE CASCADE,
  kickoff TIMESTAMPTZ NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT,
  team_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  competition_id TEXT,
  season TEXT,
  is_starter BOOLEAN,
  position TEXT,
  photo TEXT,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(fixture_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_baseball_engine_player_time ON public.baseball_engine_player_stats(player_id, kickoff DESC);
CREATE INDEX IF NOT EXISTS idx_baseball_engine_player_team_time ON public.baseball_engine_player_stats(team_id, kickoff DESC);

CREATE TABLE IF NOT EXISTS public.baseball_engine_predictions (
  fixture_id TEXT PRIMARY KEY,
  kickoff TIMESTAMPTZ NOT NULL,
  competition_id TEXT,
  season TEXT,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  prediction JSONB NOT NULL,
  actual JSONB,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_baseball_engine_predictions_time ON public.baseball_engine_predictions(kickoff DESC);

-- Cargar inmediatamente el histórico finalizado que ya posee CF Análisis.
INSERT INTO public.baseball_engine_matches(
  fixture_id,provider,provider_fixture_id,competition_id,season,kickoff,status,
  home_team_id,away_team_id,home_team,away_team,home_score,away_score,periods,raw,finalized_at
)
SELECT p.fixture_id::text,'mlb-official',p.fixture_id::text,p.league_id::text,
       EXTRACT(YEAR FROM p.date)::int::text,COALESCE(a.start_time,p.date::timestamp AT TIME ZONE 'UTC'),'FT',
       p.home_team_id::text,p.away_team_id::text,a.home_team,a.away_team,
       p.actual_home_score,p.actual_away_score,
       jsonb_build_object(
         'home',jsonb_build_array(p.actual_f5_home_score,0,0,0,0),
         'away',jsonb_build_array(p.actual_f5_away_score,0,0,0,0)
       ),'{}'::jsonb,COALESCE(p.finalized_at,now())
FROM public.baseball_match_predictions p
LEFT JOIN public.baseball_match_analysis a ON a.fixture_id=p.fixture_id
WHERE p.actual_home_score IS NOT NULL AND p.actual_away_score IS NOT NULL
ON CONFLICT(fixture_id) DO NOTHING;

INSERT INTO public.baseball_engine_team_stats(
  fixture_id,kickoff,team_id,opponent_id,competition_id,season,is_home,
  score_for,score_against,period_scores,period_scores_against,stats,result
)
SELECT p.fixture_id::text,COALESCE(a.start_time,p.date::timestamp AT TIME ZONE 'UTC'),
       p.home_team_id::text,p.away_team_id::text,p.league_id::text,EXTRACT(YEAR FROM p.date)::int::text,TRUE,
       p.actual_home_score,p.actual_away_score,
       jsonb_build_array(p.actual_f5_home_score,0,0,0,0),jsonb_build_array(p.actual_f5_away_score,0,0,0,0),
       jsonb_strip_nulls(jsonb_build_object('hits',r.home_hits,'errors',r.home_errors,
         'opponentHits',r.away_hits,'opponentErrors',r.away_errors)),
       CASE WHEN p.actual_home_score>p.actual_away_score THEN 'W' WHEN p.actual_home_score<p.actual_away_score THEN 'L' ELSE 'D' END
FROM public.baseball_match_predictions p
LEFT JOIN public.baseball_match_analysis a ON a.fixture_id=p.fixture_id
LEFT JOIN public.baseball_match_results r ON r.fixture_id=p.fixture_id
WHERE p.actual_home_score IS NOT NULL AND p.actual_away_score IS NOT NULL
UNION ALL
SELECT p.fixture_id::text,COALESCE(a.start_time,p.date::timestamp AT TIME ZONE 'UTC'),
       p.away_team_id::text,p.home_team_id::text,p.league_id::text,EXTRACT(YEAR FROM p.date)::int::text,FALSE,
       p.actual_away_score,p.actual_home_score,
       jsonb_build_array(p.actual_f5_away_score,0,0,0,0),jsonb_build_array(p.actual_f5_home_score,0,0,0,0),
       jsonb_strip_nulls(jsonb_build_object('hits',r.away_hits,'errors',r.away_errors,
         'opponentHits',r.home_hits,'opponentErrors',r.home_errors)),
       CASE WHEN p.actual_away_score>p.actual_home_score THEN 'W' WHEN p.actual_away_score<p.actual_home_score THEN 'L' ELSE 'D' END
FROM public.baseball_match_predictions p
LEFT JOIN public.baseball_match_analysis a ON a.fixture_id=p.fixture_id
LEFT JOIN public.baseball_match_results r ON r.fixture_id=p.fixture_id
WHERE p.actual_home_score IS NOT NULL AND p.actual_away_score IS NOT NULL
ON CONFLICT(fixture_id,team_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tablas totalmente independientes para NBA y NFL
-- ---------------------------------------------------------------------------
DO $create_multisport$
DECLARE
  prefix TEXT;
BEGIN
  FOREACH prefix IN ARRAY ARRAY['basketball','american_football'] LOOP
    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS public.%I (
        fixture_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_fixture_id TEXT NOT NULL,
        competition_id TEXT,
        season TEXT,
        kickoff TIMESTAMPTZ NOT NULL,
        status TEXT,
        home_team_id TEXT NOT NULL,
        away_team_id TEXT NOT NULL,
        home_team TEXT,
        away_team TEXT,
        home_logo TEXT,
        away_logo TEXT,
        home_score NUMERIC,
        away_score NUMERIC,
        periods JSONB NOT NULL DEFAULT '{}'::jsonb,
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        finalized_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )$sql$, prefix||'_engine_matches');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(kickoff)', 'idx_'||prefix||'_engine_matches_time', prefix||'_engine_matches');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(provider,provider_fixture_id)', 'idx_'||prefix||'_engine_matches_provider', prefix||'_engine_matches');

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS public.%I (
        fixture_id TEXT NOT NULL REFERENCES public.%I(fixture_id) ON DELETE CASCADE,
        kickoff TIMESTAMPTZ NOT NULL,
        team_id TEXT NOT NULL,
        opponent_id TEXT NOT NULL,
        competition_id TEXT,
        season TEXT,
        is_home BOOLEAN NOT NULL,
        score_for NUMERIC,
        score_against NUMERIC,
        period_scores JSONB NOT NULL DEFAULT '[]'::jsonb,
        period_scores_against JSONB NOT NULL DEFAULT '[]'::jsonb,
        stats JSONB NOT NULL DEFAULT '{}'::jsonb,
        result CHAR(1),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(fixture_id, team_id)
      )$sql$, prefix||'_engine_team_stats', prefix||'_engine_matches');

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(team_id,kickoff DESC)', 'idx_'||prefix||'_engine_team_time', prefix||'_engine_team_stats');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(opponent_id,kickoff DESC)', 'idx_'||prefix||'_engine_opp_time', prefix||'_engine_team_stats');

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS public.%I (
        fixture_id TEXT NOT NULL REFERENCES public.%I(fixture_id) ON DELETE CASCADE,
        kickoff TIMESTAMPTZ NOT NULL,
        player_id TEXT NOT NULL,
        player_name TEXT,
        team_id TEXT NOT NULL,
        opponent_id TEXT NOT NULL,
        competition_id TEXT,
        season TEXT,
        is_starter BOOLEAN,
        position TEXT,
        photo TEXT,
        stats JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(fixture_id, player_id)
      )$sql$, prefix||'_engine_player_stats', prefix||'_engine_matches');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(player_id,kickoff DESC)', 'idx_'||prefix||'_engine_player_time', prefix||'_engine_player_stats');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(team_id,kickoff DESC)', 'idx_'||prefix||'_engine_player_team_time', prefix||'_engine_player_stats');

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS public.%I (
        fixture_id TEXT PRIMARY KEY,
        kickoff TIMESTAMPTZ NOT NULL,
        competition_id TEXT,
        season TEXT,
        home_team_id TEXT NOT NULL,
        away_team_id TEXT NOT NULL,
        prediction JSONB NOT NULL,
        actual JSONB,
        finalized_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )$sql$, prefix||'_engine_predictions');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(kickoff DESC)', 'idx_'||prefix||'_engine_predictions_time', prefix||'_engine_predictions');

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS public.%I (
        fixture_id TEXT PRIMARY KEY,
        date DATE NOT NULL,
        league_id TEXT,
        league_name TEXT,
        country TEXT,
        home_team_id TEXT,
        away_team_id TEXT,
        home_team TEXT,
        away_team TEXT,
        status TEXT,
        start_time TIMESTAMPTZ,
        analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
        odds JSONB NOT NULL DEFAULT '[]'::jsonb,
        best_odds JSONB NOT NULL DEFAULT '{}'::jsonb,
        probabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
        combinada JSONB NOT NULL DEFAULT '{}'::jsonb,
        data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
        cache_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )$sql$, prefix||'_match_analysis');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(date,start_time)', 'idx_'||prefix||'_analysis_date', prefix||'_match_analysis');

    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS public.%I (
        date DATE PRIMARY KEY,
        schedule JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )$sql$, prefix||'_match_schedule');
  END LOOP;
END
$create_multisport$;

-- Garantizar cache_version de baseball existente para el nuevo contrato.
ALTER TABLE public.baseball_match_analysis ADD COLUMN IF NOT EXISTS cache_version INTEGER NOT NULL DEFAULT 1;

-- El rol de la aplicación necesita operar las tablas tras aplicar la migración.
DO $grant_app$
DECLARE
  table_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cfanalisis') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'baseball_engine_matches','baseball_engine_team_stats',
      'baseball_engine_player_stats','baseball_engine_predictions',
      'basketball_engine_matches','basketball_engine_team_stats',
      'basketball_engine_player_stats','basketball_engine_predictions',
      'basketball_match_analysis','basketball_match_schedule',
      'american_football_engine_matches','american_football_engine_team_stats',
      'american_football_engine_player_stats','american_football_engine_predictions',
      'american_football_match_analysis','american_football_match_schedule'
    ] LOOP
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO cfanalisis', table_name);
    END LOOP;
  END IF;
END
$grant_app$;

COMMIT;
