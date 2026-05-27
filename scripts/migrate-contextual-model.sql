-- ────────────────────────────────────────────────────────────────────────
-- Fase 2 del sistema de predicción contextual: tablas del meta-modelo.
--   psql "$DATABASE_URL" -f scripts/migrate-contextual-model.sql
-- ────────────────────────────────────────────────────────────────────────

-- ADN del equipo por métrica/segmento (reconstruido cada noche).
CREATE TABLE IF NOT EXISTS team_market_profiles (
  sport        TEXT NOT NULL DEFAULT 'football',
  team_id      INT  NOT NULL,
  metric       TEXT NOT NULL,        -- 'homeWinRate','bttsRate','over25Rate','cornersForAvg',...
  segment      TEXT NOT NULL DEFAULT 'all',
  sample_n     INT  NOT NULL,
  emp_value    REAL,                 -- empírico crudo (tasa 0-1 o promedio)
  shrunk_value REAL,                 -- con shrinkage hacia prior de liga/global
  consistency  REAL,                 -- 0-1 (soporte muestral)
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (sport, team_id, metric, segment)
);

-- Meta-modelos entrenados (uno por mercado), versionados.
CREATE TABLE IF NOT EXISTS prediction_models (
  sport       TEXT NOT NULL DEFAULT 'football',
  market_key  TEXT NOT NULL,
  version     INT  NOT NULL,
  model_type  TEXT NOT NULL DEFAULT 'logistic',
  weights     JSONB NOT NULL,        -- {bias, coefs, means, stds, features[]}
  metrics     JSONB,                 -- {n, logloss, brier, base_logloss, base_brier, beats_baseline}
  active      BOOLEAN DEFAULT FALSE,
  trained_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (sport, market_key, version)
);
CREATE INDEX IF NOT EXISTS idx_prediction_models_active
  ON prediction_models (sport, market_key) WHERE active;

-- Diagnóstico por segmento — para ENTENDER por qué falla un mercado (no excluirlo).
CREATE TABLE IF NOT EXISTS market_segment_diagnostics (
  sport             TEXT NOT NULL DEFAULT 'football',
  market_key        TEXT NOT NULL,
  segment           TEXT NOT NULL,
  sample_n          INT,
  avg_pred          REAL,
  avg_actual        REAL,
  brier             REAL,
  calibration_error REAL,
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (sport, market_key, segment)
);
