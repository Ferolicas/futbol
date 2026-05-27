-- ────────────────────────────────────────────────────────────────────────
-- Fase 1 del sistema de predicción contextual.
-- Añade el snapshot de FEATURES de contexto (point-in-time) por partido, en
-- paralelo a predictions_full (probs) y actuals_full (resultado).
--
-- features_full guarda el estado JUSTO ANTES del saque: posición en tabla,
-- forma últimos 5, cuota implícita, lesionados clave, fase/competición,
-- causalidad (remates/posesión/xG) y el ADN del equipo por mercado.
--
-- Correr en el VPS:
--   psql "$DATABASE_URL" -f scripts/migrate-features-full.sql
--   (o)  node --env-file=.env -e "..."  /  vía /api/admin/setup-db
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE match_predictions
  ADD COLUMN IF NOT EXISTS features_full JSONB;

COMMENT ON COLUMN match_predictions.features_full IS
  'Snapshot point-in-time de features de contexto al momento de la predicción '
  '(posición, forma L5, cuota implícita, lesionados, fase, causalidad, ADN por '
  'mercado). Lo escribe lib/feature-snapshot.js en vivo y scripts/backfill-features.js '
  'para el histórico. Alimenta el meta-modelo contextual.';

-- Índice parcial para el backfill incremental (busca rápido los que faltan).
CREATE INDEX IF NOT EXISTS idx_match_predictions_features_null
  ON match_predictions (kickoff)
  WHERE features_full IS NULL;
