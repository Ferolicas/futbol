-- =============================================================================
-- BASEBALL ML — esquema mínimo viable para entrenar 3 modelos por mercado
--   home_win, run_line_home_minus_15, total_over_85
--
-- Crea:
--   equipos_mlb       — 30 equipos MLB + park_factor del estadio
--   features_baseball — 10 features point-in-time por juego (input ML)
--
-- Las predicciones (labels) ya viven en baseball_match_predictions
-- (p_* y actual_*). Los modelos entrenados se guardan en prediction_models
-- (tabla compartida con fútbol, columna sport='baseball').
--
-- Ejecutar una vez en el VPS:
--   PGPASSWORD='Pump0517*' psql -h 127.0.0.1 -p 5432 -U cfanalisis -d cfanalisis \
--     -f scripts/migrate-baseball-ml.sql
-- =============================================================================

BEGIN;

-- ── 30 equipos MLB ──────────────────────────────────────────────────────
-- team_id = MLB Stats API team ID (estable, oficial). park_factor = factor
-- multiplicativo del estadio sobre run scoring (1.0 = neutral, >1 hitter
-- friendly). Seed inicial vía scripts/seed-equipos-mlb.js (lee la API + aplica
-- los 30 park factors hardcodeados por team_id).
CREATE TABLE IF NOT EXISTS public.equipos_mlb (
  team_id      INT  PRIMARY KEY,         -- MLB Stats API team ID
  name         TEXT NOT NULL,            -- "Los Angeles Dodgers"
  abbreviation TEXT,                     -- "LAD"
  league       TEXT,                     -- "AL" | "NL"
  division     TEXT,                     -- "AL East" | "NL Central" | ...
  venue_name   TEXT,                     -- "Dodger Stadium"
  park_factor  REAL NOT NULL DEFAULT 1.0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_equipos_mlb_league
  ON public.equipos_mlb (league);
CREATE INDEX IF NOT EXISTS idx_equipos_mlb_division
  ON public.equipos_mlb (division);

COMMENT ON TABLE  public.equipos_mlb IS 'Catálogo de los 30 equipos MLB con park factor del estadio (FanGraphs/Baseball Reference).';
COMMENT ON COLUMN public.equipos_mlb.park_factor IS 'Factor multiplicativo sobre run scoring; 1.0 neutral, >1 hitter friendly, <1 pitcher friendly.';

-- ── Features point-in-time por juego ────────────────────────────────────
-- Una fila por fixture (gamePk MLB). Las features se calculan con SOLO datos
-- de juegos ANTES de game_date (sin leakage). Si ningún juego previo cumple
-- ventana mínima (10/30/5), la feature queda NULL (el modelo imputa con
-- means[] en runtime, igual que fútbol).
CREATE TABLE IF NOT EXISTS public.features_baseball (
  fixture_id        BIGINT  PRIMARY KEY,    -- gamePk MLB
  game_date         DATE    NOT NULL,
  home_team_id      INT     NOT NULL REFERENCES public.equipos_mlb(team_id),
  away_team_id      INT     NOT NULL REFERENCES public.equipos_mlb(team_id),

  -- (1-3) Equipo local — ventana 10 juegos / 30 juegos
  home_win_rate_last_10           REAL,
  home_runs_per_game_last_30      REAL,
  home_runs_allowed_last_30       REAL,

  -- (4-6) Equipo visitante
  away_win_rate_last_10           REAL,
  away_runs_per_game_last_30      REAL,
  away_runs_allowed_last_30       REAL,

  -- (7-8) Pitcher abridor — ventana 5 aperturas
  home_starter_era_last_5         REAL,
  away_starter_era_last_5         REAL,

  -- (9) Juego de división (ambos equipos misma división)
  is_division_game                BOOLEAN NOT NULL DEFAULT FALSE,

  -- (10) Park factor del estadio local (snapshot al momento del juego;
  --      casi siempre = equipos_mlb.park_factor, snapshot para reproducibilidad)
  home_stadium_park_factor        REAL    NOT NULL DEFAULT 1.0,

  -- Meta — created_at para auditar cuándo se enriquecio cada fixture
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_features_baseball_date
  ON public.features_baseball (game_date);
CREATE INDEX IF NOT EXISTS idx_features_baseball_home_team
  ON public.features_baseball (home_team_id, game_date);
CREATE INDEX IF NOT EXISTS idx_features_baseball_away_team
  ON public.features_baseball (away_team_id, game_date);

COMMENT ON TABLE public.features_baseball IS 'Features point-in-time por fixture MLB. Calculadas con datos ANTERIORES a game_date — input ML. Una fila por gamePk.';

-- (RLS omitido a propósito: el VPS Postgres no usa Supabase, no existe el rol
--  service_role. El acceso a estas tablas se hace siempre con el usuario
--  `cfanalisis` que tiene permisos completos. Si alguna vez se vuelve a
--  Supabase, añadir aquí las policies equivalentes a las del resto de
--  baseball_*.)

COMMIT;

-- Verificación post-migración:
--   SELECT to_regclass('public.equipos_mlb')        IS NOT NULL AS ok_equipos;
--   SELECT to_regclass('public.features_baseball')  IS NOT NULL AS ok_features;
--   SELECT COUNT(*) FROM equipos_mlb;  -- esperar 0 hasta correr el seed; 30 después
