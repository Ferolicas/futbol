-- ════════════════════════════════════════════════════════════════════════
-- FASE 2A — Esquema relacional del modelo CFanalisis (schema aislado `model`).
--
--   psql "$DATABASE_URL" -f scripts/model/2a-schema.sql
--
-- NO toca raw_api_payloads ni las tablas de la app. Reconstruible desde el crudo.
-- Idempotente: CREATE ... IF NOT EXISTS; toda ingesta posterior es UPSERT por PK.
--
-- CONTRATO DE NORMALIZACIÓN NUMÉRICA (lo aplica la ingesta 2B, NO el DDL):
--   API-Football devuelve varios numéricos como STRING, a veces con '%'
--   (possession "55%", pass.accuracy "82%") o como string decimal (rating "7.2",
--   expected_goals "1.45"). Las columnas aquí son NUMÉRICAS (guardamos el número,
--   no el texto). La ingesta 2B normaliza TODO valor numérico con un único parser:
--     v == null || v === ''            → NULL
--     typeof v === 'number'            → v
--     string                           → parseFloat(String(v).replace('%','').trim())
--                                        (→ NULL si NaN)
--   (mismo criterio que lib/adn.js:statVal). Así "82%" entra como 82, "7.2" como
--   7.2, y un campo ausente como NULL — nunca rompe el INSERT.
-- ════════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS model;

-- Checkpoint resumable para las ingestas/backfills (2B/2C/2E).
CREATE TABLE IF NOT EXISTS model.ingest_checkpoint (
  job         text PRIMARY KEY,        -- 'ingest_facts' | 'backfill_players' | ...
  last_ref    bigint,                  -- último fixture/team procesado
  processed   bigint DEFAULT 0,
  total       bigint,
  status      text,                    -- running|done|error
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────── DIMENSIÓN ───────────────────────────────
CREATE TABLE IF NOT EXISTS model.competitions (
  competition_id bigint PRIMARY KEY,          -- = API league.id
  name           text NOT NULL,
  country        text,
  confederation  text,
  type           text,                        -- 'league' | 'cup'
  category       text,                        -- domestic_league|domestic_cup|continental_club|national_team|friendly_intl
  is_national    boolean NOT NULL DEFAULT false,
  tier           int,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model.competition_seasons (
  competition_id bigint NOT NULL REFERENCES model.competitions(competition_id),
  season         int    NOT NULL,
  start_date     date,
  end_date       date,
  n_teams        int,
  n_matchdays    int,
  points_for_win int NOT NULL DEFAULT 3,
  has_table      boolean NOT NULL DEFAULT true,  -- false = copa/knockout/amistoso (sin tabla → usa phase)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, season)
);

CREATE TABLE IF NOT EXISTS model.teams (
  team_id        bigint PRIMARY KEY,
  name           text NOT NULL,
  short_name     text,
  country        text,
  is_national    boolean NOT NULL DEFAULT false,
  founded        int,
  venue_id       bigint,
  venue_name     text,
  venue_city     text,
  venue_capacity int,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model.players (              -- ENTIDAD ÚNICA, sin equipo fijo
  player_id        bigint PRIMARY KEY,
  name             text NOT NULL,
  firstname        text,
  lastname         text,
  nationality      text,
  birth_date       date,
  height_cm        int,
  weight_kg        int,
  primary_position text,                                -- derivado (posición modal)
  photo            text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ──────────────────────────────── HECHOS ─────────────────────────────────
CREATE TABLE IF NOT EXISTS model.matches (
  fixture_id      bigint PRIMARY KEY,
  competition_id  bigint REFERENCES model.competitions(competition_id),
  season          int,
  round           text,
  matchday        int,                          -- derivado
  phase           text,                         -- regular|group|knockout|final
  kickoff         timestamptz NOT NULL,
  status          text,
  home_team_id    bigint REFERENCES model.teams(team_id),
  away_team_id    bigint REFERENCES model.teams(team_id),
  venue_id        bigint,
  referee         text,
  ft_home int, ft_away int, ht_home int, ht_away int, et_home int, et_away int,
  result          char(1),                      -- H|D|A
  -- situacional DERIVADO point-in-time (null en copas/selecciones sin tabla)
  home_rank_before int, away_rank_before int,
  home_points_before int, away_points_before int,
  home_played_before int, away_played_before int,
  matches_remaining_home int, matches_remaining_away int,
  -- rank OFICIAL de la API (poblado de hoy en adelante — 2E)
  home_rank_official int, away_rank_official int,
  -- cobertura
  stats_available   boolean,                    -- fixtures/statistics no vacío
  players_available boolean,                    -- fixtures/players presente
  ingested_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_matches_comp_season_kickoff ON model.matches(competition_id, season, kickoff);
CREATE INDEX IF NOT EXISTS ix_matches_home_kickoff        ON model.matches(home_team_id, kickoff);
CREATE INDEX IF NOT EXISTS ix_matches_away_kickoff        ON model.matches(away_team_id, kickoff);
CREATE INDEX IF NOT EXISTS ix_matches_kickoff             ON model.matches(kickoff);

CREATE TABLE IF NOT EXISTS model.team_match_stats (       -- 2 filas/partido (perspectiva por equipo)
  fixture_id   bigint NOT NULL REFERENCES model.matches(fixture_id) ON DELETE CASCADE,
  team_id      bigint NOT NULL,
  opponent_id  bigint,
  competition_id bigint, competition_category text, season int,
  kickoff      timestamptz, is_home boolean NOT NULL, phase text,
  result       char(1),                         -- W|D|L
  goals_for int, goals_against int, total_goals int,
  btts boolean, clean_sheet boolean, scored boolean, conceded boolean, first_goal_minute int,
  corners_for int, corners_against int, shots_for int, shots_against int,
  sot_for int, sot_against int, fouls_for int, fouls_against int,
  offsides_for int, offsides_against int,
  possession numeric(5,2),                       -- "Ball Possession" llega como "55%" → ingesta 2B quita '%' y parsea
  yellow_for int, yellow_against int, red_for int, red_against int,
  xg_for numeric(6,3), xg_against numeric(6,3),  -- "expected_goals" llega como string "1.45" → ingesta 2B parsea
  gf_1h int, gf_2h int, ga_1h int, ga_2h int,
  corners_1h int, corners_2h int, shots_1h int, shots_2h int,
  sot_1h int, sot_2h int, fouls_1h int, fouls_2h int,
  had_red_for boolean, had_red_against boolean,
  stats_present boolean,                         -- el hueco J2/Uruguay (statistics vacío)
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_id, team_id)
);
CREATE INDEX IF NOT EXISTS ix_tms_team_home_kickoff ON model.team_match_stats(team_id, is_home, kickoff);
CREATE INDEX IF NOT EXISTS ix_tms_team_comp_kickoff ON model.team_match_stats(team_id, competition_id, kickoff);
CREATE INDEX IF NOT EXISTS ix_tms_team_opp_kickoff  ON model.team_match_stats(team_id, opponent_id, kickoff);

CREATE TABLE IF NOT EXISTS model.player_match_stats (     -- núcleo del perfil multi-competencia
  fixture_id  bigint NOT NULL REFERENCES model.matches(fixture_id) ON DELETE CASCADE,
  player_id   bigint NOT NULL,
  team_id     bigint, opponent_id bigint,
  competition_id bigint, competition_category text, season int,
  kickoff     timestamptz, is_home boolean, phase text,
  minutes int, position text, is_starter boolean, is_captain boolean, is_substitute boolean,
  rating numeric(4,2),                           -- llega como string "7.2" → ingesta 2B parsea
  goals int, assists int, shots_total int, shots_on int,
  key_passes int, passes_total int,
  pass_accuracy int,                             -- llega como "82%" o número → ingesta 2B normaliza (strip '%', parseFloat→round)
  tackles int, interceptions int, blocks int, duels_total int, duels_won int,
  dribbles_attempts int, dribbles_success int,
  fouls_committed int, fouls_drawn int, yellow int, red int, offsides int,
  penalty_won int, penalty_committed int, penalty_scored int, penalty_missed int, penalty_saved int,
  saves int, goals_conceded int,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_id, player_id)
);
CREATE INDEX IF NOT EXISTS ix_pms_player_kickoff     ON model.player_match_stats(player_id, kickoff);
CREATE INDEX IF NOT EXISTS ix_pms_player_cat_kickoff ON model.player_match_stats(player_id, competition_category, kickoff);
CREATE INDEX IF NOT EXISTS ix_pms_player_season      ON model.player_match_stats(player_id, season);
CREATE INDEX IF NOT EXISTS ix_pms_team_kickoff       ON model.player_match_stats(team_id, kickoff);

CREATE TABLE IF NOT EXISTS model.match_events (
  event_id    bigserial PRIMARY KEY,
  fixture_id  bigint NOT NULL REFERENCES model.matches(fixture_id) ON DELETE CASCADE,
  minute int, extra_minute int,
  type text, detail text, comments text,
  team_id bigint, player_id bigint, assist_player_id bigint
);
-- idempotencia: clave natural del evento (re-ingesta no duplica; la API no da id estable)
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_natural ON model.match_events
  (fixture_id, minute, type, COALESCE(player_id,0), COALESCE(team_id,0), COALESCE(detail,''));
CREATE INDEX IF NOT EXISTS ix_events_player_type ON model.match_events(player_id, type);

CREATE TABLE IF NOT EXISTS model.lineups (
  fixture_id bigint NOT NULL REFERENCES model.matches(fixture_id) ON DELETE CASCADE,
  team_id    bigint NOT NULL, player_id bigint NOT NULL,
  is_starter boolean NOT NULL, position text, grid text, formation text, coach_id bigint,
  PRIMARY KEY (fixture_id, team_id, player_id)
);
CREATE INDEX IF NOT EXISTS ix_lineups_player_starter ON model.lineups(player_id, is_starter);
CREATE INDEX IF NOT EXISTS ix_lineups_team           ON model.lineups(team_id);

CREATE TABLE IF NOT EXISTS model.match_injuries (
  injury_id  bigserial PRIMARY KEY,
  fixture_id bigint REFERENCES model.matches(fixture_id) ON DELETE CASCADE,  -- null = nivel temporada
  team_id    bigint NOT NULL, player_id bigint NOT NULL,
  season int, type text, reason text, report_date date
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_injuries_natural ON model.match_injuries
  (COALESCE(fixture_id,0), team_id, player_id, COALESCE(report_date,DATE '1900-01-01'), COALESCE(reason,''));
CREATE INDEX IF NOT EXISTS ix_injuries_team_season ON model.match_injuries(team_id, season);
CREATE INDEX IF NOT EXISTS ix_injuries_player      ON model.match_injuries(player_id);

-- ──────────────────────── DERIVADO SITUACIONAL ───────────────────────────
CREATE TABLE IF NOT EXISTS model.standings_snapshots (
  competition_id bigint NOT NULL, season int NOT NULL, team_id bigint NOT NULL,
  as_of_date     date   NOT NULL,                 -- estado ANTES de los partidos de esa fecha
  source         text   NOT NULL DEFAULT 'derived', -- derived | official
  played int, won int, drawn int, lost int,
  gf int, ga int, gd int, points int, rank int, form5 text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, season, team_id, as_of_date, source)
);
CREATE INDEX IF NOT EXISTS ix_standings_comp_season_date ON model.standings_snapshots(competition_id, season, as_of_date);
CREATE INDEX IF NOT EXISTS ix_standings_team             ON model.standings_snapshots(team_id, competition_id, season);

-- ───────────────────────────── PERFILES ──────────────────────────────────
CREATE TABLE IF NOT EXISTS model.team_profiles (
  team_id bigint NOT NULL,
  scope_venue text NOT NULL,         -- home|away|all
  scope_competition text NOT NULL,   -- all|domestic_league|continental|cup
  time_window text NOT NULL,         -- career|s{season}|last10
  sample_n int,
  goals_for_avg real, goals_against_avg real, shots_for_avg real, shots_against_avg real,
  sot_for_avg real, corners_for_avg real, corners_against_avg real,
  fouls_avg real, offsides_avg real, yellow_avg real, red_rate real,
  xg_for_avg real, xg_against_avg real,
  scoring_rate real, clean_sheet_rate real, btts_rate real,
  over05_rate real, over15_rate real, over25_rate real, over35_rate real,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, scope_venue, scope_competition, time_window)
);
CREATE INDEX IF NOT EXISTS ix_team_profiles_team ON model.team_profiles(team_id);

CREATE TABLE IF NOT EXISTS model.player_profiles (
  player_id bigint NOT NULL,
  scope text NOT NULL,               -- all|domestic_league|national_team|continental|cup
  time_window text NOT NULL,         -- career|s{season}|last10
  sample_n int,
  minutes_avg real, goals_avg real, assists_avg real, shots_avg real, sot_avg real,
  fouls_avg real, yellow_avg real, rating_avg real,
  appearance_rate real, scoring_rate real, shots_on_rate real, anytime_scorer_rate real, card_rate real,
  last_played_date date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, scope, time_window)
);
CREATE INDEX IF NOT EXISTS ix_player_profiles_player ON model.player_profiles(player_id);
