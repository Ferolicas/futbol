-- ────────────────────────────────────────────────────────────────────────
-- Historial PERMANENTE por equipo de la temporada (log de partidos con stats).
-- Es el ADN real: 30-38 partidos por equipo en ligas domésticas, no los ~5 que
-- aparecen en match_predictions. Lo puebla scripts/backfill-team-season.js y, a
-- futuro, el cron nocturno de forma incremental.
--   psql "$DATABASE_URL" -f scripts/migrate-team-season-history.sql
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_season_history (
  sport           TEXT NOT NULL DEFAULT 'football',
  team_id         INT  NOT NULL,
  season          INT  NOT NULL,
  fixture_id      BIGINT NOT NULL,
  date            TIMESTAMPTZ,
  league_id       INT,
  venue           TEXT,          -- 'home' | 'away'
  opponent_id     INT,
  result          TEXT,          -- 'W' | 'D' | 'L'
  goals_for       INT,
  goals_against   INT,
  corners_for     INT,
  corners_against INT,
  cards_for       INT,           -- amarillas + rojas
  shots_for       INT,
  shots_against   INT,
  sot_for         INT,
  fouls_for       INT,
  possession_for  REAL,
  xg_for          REAL,
  xg_against      REAL,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_id, fixture_id)
);

CREATE INDEX IF NOT EXISTS idx_tsh_team_season ON team_season_history (team_id, season);
CREATE INDEX IF NOT EXISTS idx_tsh_venue       ON team_season_history (team_id, venue);
