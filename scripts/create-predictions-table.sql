-- match_predictions: one row per analyzed fixture
-- Populated at analysis time; actual_* columns filled by finalize cron.
-- Enables model calibration: compare predicted probabilities vs real outcomes.

CREATE TABLE IF NOT EXISTS match_predictions (
  id               SERIAL PRIMARY KEY,
  fixture_id       BIGINT  UNIQUE NOT NULL,
  date             DATE    NOT NULL,
  league_id        INTEGER,
  league_name      TEXT,
  home_team        JSONB,          -- { id, name, logo }
  away_team        JSONB,          -- { id, name, logo }
  kickoff          TIMESTAMPTZ,
  home_position    INTEGER,        -- league table rank at prediction time
  away_position    INTEGER,

  -- Dixon-Coles model outputs
  lambda_home      FLOAT,          -- expected goals home
  lambda_away      FLOAT,          -- expected goals away
  p_home_win       INTEGER,        -- probability % (5–95)
  p_draw           INTEGER,
  p_away_win       INTEGER,
  p_btts           INTEGER,
  p_over_15        INTEGER,
  p_over_25        INTEGER,
  p_over_35        INTEGER,
  p_corners_over_85  INTEGER,
  p_corners_over_95  INTEGER,
  model_version    TEXT DEFAULT 'dc-v1',

  -- Actual results (filled by finalize cron after match ends)
  actual_home_goals   INTEGER,
  actual_away_goals   INTEGER,
  actual_result       CHAR(1),     -- 'H', 'D', 'A'
  actual_btts         BOOLEAN,
  actual_total_goals  INTEGER,
  actual_corners      INTEGER,

  created_at       TIMESTAMPTZ DEFAULT NOW(),
  finalized_at     TIMESTAMPTZ
);

-- Indexes for calibration queries
CREATE INDEX IF NOT EXISTS idx_mp_date        ON match_predictions (date);
CREATE INDEX IF NOT EXISTS idx_mp_league      ON match_predictions (league_id);
CREATE INDEX IF NOT EXISTS idx_mp_finalized   ON match_predictions (finalized_at) WHERE finalized_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mp_model       ON match_predictions (model_version);

-- Row-level security: read-only for anon, write only via service role
ALTER TABLE match_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON match_predictions
  USING (auth.role() = 'service_role');
