-- ─────────────────────────────────────────────────────────────────────────
-- Migration: añadir predictions_full y actuals_full a match_predictions
-- Para calibración isotonic sobre TODOS los mercados (no solo los 14 viejos).
-- Run on PG VPS:
--   PGPASSWORD='Pump0517*' psql -h 127.0.0.1 -p 6432 -U cfanalisis \
--     -d cfanalisis -f scripts/migrate-predictions-full.sql
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE match_predictions
  ADD COLUMN IF NOT EXISTS predictions_full JSONB,
  ADD COLUMN IF NOT EXISTS actuals_full     JSONB;

-- Index para acelerar SELECT * FROM match_predictions WHERE finalized_at IS NOT NULL
-- (lo usa build-calibration.js cada vez que se reconstruye la calibración).
CREATE INDEX IF NOT EXISTS idx_match_predictions_finalized
  ON match_predictions (finalized_at)
  WHERE finalized_at IS NOT NULL;

-- Verifica columnas (debe aparecer predictions_full y actuals_full)
\d match_predictions

-- Conteo: cuántas filas ya finalizadas tenemos disponibles para calibrar
SELECT
  COUNT(*) AS total_finalized,
  COUNT(predictions_full) AS with_predictions_full,
  COUNT(actuals_full) AS with_actuals_full
FROM match_predictions
WHERE finalized_at IS NOT NULL;
