-- ────────────────────────────────────────────────────────────────────────
-- Fase 5 — almacén AUDITABLE del contexto por mercado y partido. Guarda los
-- ~1133 mercados (recomendados o no) con su frecuencia, prob_final, nivel,
-- muestra, confianza, ruptura y excepciones.
--   psql "$DATABASE_URL" -f scripts/migrate-market-context.sql
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_context_analysis (
  fixture_id    BIGINT  NOT NULL,
  market_key    TEXT    NOT NULL,
  prob          REAL,                 -- frecuencia del contexto (1X2/ternas: normalizada a 100%)
  prob_final    REAL,                 -- prob tras veto: prob·(1−α·rupture)
  level         TEXT,                 -- 'h2h' | 'adn'
  sample_n      INT,                  -- nº de cruces (H2H) o registros (ADN)
  confidence    REAL,                 -- 0-1, ponderada por muestra y ruptura
  rupture_score REAL,                 -- 0-1
  recommended   BOOLEAN DEFAULT FALSE,
  exceptions    JSONB,                -- cruces que rompieron el patrón [{fixtureId,date}]
  date          DATE,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (fixture_id, market_key)
);

CREATE INDEX IF NOT EXISTS idx_mca_fixture     ON market_context_analysis (fixture_id);
CREATE INDEX IF NOT EXISTS idx_mca_recommended ON market_context_analysis (fixture_id) WHERE recommended;
CREATE INDEX IF NOT EXISTS idx_mca_date        ON market_context_analysis (date);
