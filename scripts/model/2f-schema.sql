-- ════════════════════════════════════════════════════════════════════════
-- FASE 2F — ajuste de schema de perfiles (las tablas están VACÍAS → DROP+CREATE seguro).
--   psql "$DATABASE_URL" -f scripts/model/2f-schema.sql
-- Cambios vs 2A: team_profiles gana scope_phase (all|knockout) en el PK;
-- player_profiles gana per-90 (shots/sot/fouls/cards). 2a-schema.sql queda alineado
-- para instalaciones nuevas; este archivo migra las tablas ya creadas (vacías).
-- ════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS model.team_profiles;
CREATE TABLE model.team_profiles (
  team_id bigint NOT NULL,
  scope_venue text NOT NULL,         -- home|away|all
  scope_competition text NOT NULL,   -- all|domestic_league|continental|cup
  scope_phase text NOT NULL,         -- all|knockout (FASE 2F)
  time_window text NOT NULL,         -- career|s{season}|last10
  sample_n int,                      -- partidos del slice (el motor modula confianza con esto)
  goals_for_avg real, goals_against_avg real, shots_for_avg real, shots_against_avg real,
  sot_for_avg real, corners_for_avg real, corners_against_avg real,
  fouls_avg real, offsides_avg real, yellow_avg real, red_rate real,
  xg_for_avg real, xg_against_avg real,
  scoring_rate real, clean_sheet_rate real, btts_rate real,
  over05_rate real, over15_rate real, over25_rate real, over35_rate real,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, scope_venue, scope_competition, scope_phase, time_window)
);
CREATE INDEX IF NOT EXISTS ix_team_profiles_team ON model.team_profiles(team_id);

DROP TABLE IF EXISTS model.player_profiles;
CREATE TABLE model.player_profiles (
  player_id bigint NOT NULL,
  scope text NOT NULL,               -- all|domestic_league|national_team|continental|cup
  time_window text NOT NULL,         -- career|s{season}|last10
  sample_n int,                      -- apariciones (el motor modula confianza con esto)
  minutes_avg real, goals_avg real, assists_avg real, shots_avg real, sot_avg real,
  fouls_avg real, yellow_avg real, rating_avg real,
  appearance_rate real,              -- titularidad (starts/apariciones)
  scoring_rate real,                 -- goles por 90'
  shots_on_rate real, anytime_scorer_rate real, card_rate real,   -- P(≥1) por partido (mercados de jugador)
  shots_per90 real, sot_per90 real, fouls_per90 real, cards_per90 real,  -- FASE 2F per-90
  last_played_date date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, scope, time_window)
);
CREATE INDEX IF NOT EXISTS ix_player_profiles_player ON model.player_profiles(player_id);
