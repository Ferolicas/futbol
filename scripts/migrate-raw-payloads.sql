-- ────────────────────────────────────────────────────────────────────────
-- Captura CRUDA total (Camino B): un payload JSONB por endpoint de
-- API-Football, sin filtrar. El modelo/ADN se construye DESPUÉS leyendo de aquí.
--   psql "$DATABASE_URL" -f scripts/migrate-raw-payloads.sql
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS raw_api_payloads (
  endpoint   TEXT   NOT NULL,        -- 'fixtures' | 'fixtures/statistics' | 'teams/statistics' | ...
  ref_type   TEXT   NOT NULL,        -- 'fixture' | 'team'
  ref_id     BIGINT NOT NULL,        -- fixture_id | team_id
  season     INT,
  sub_key    TEXT   NOT NULL DEFAULT '',  -- desambigua (league_id, página, etc.)
  payload    JSONB  NOT NULL,        -- respuesta CRUDA completa, sin tocar
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (endpoint, ref_id, sub_key)
);

CREATE INDEX IF NOT EXISTS idx_raw_ref      ON raw_api_payloads (ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_raw_endpoint ON raw_api_payloads (endpoint);
CREATE INDEX IF NOT EXISTS idx_raw_season   ON raw_api_payloads (season);
