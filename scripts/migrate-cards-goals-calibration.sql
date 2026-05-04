-- Extiende match_predictions con mercados de tarjetas, primer gol y goleadores.
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.

ALTER TABLE match_predictions
  ADD COLUMN IF NOT EXISTS p_cards_over_25 INTEGER,
  ADD COLUMN IF NOT EXISTS p_cards_over_35 INTEGER,
  ADD COLUMN IF NOT EXISTS p_cards_over_45 INTEGER,
  ADD COLUMN IF NOT EXISTS p_first_goal_30 INTEGER,
  ADD COLUMN IF NOT EXISTS p_first_goal_45 INTEGER,
  ADD COLUMN IF NOT EXISTS predicted_scorers JSONB,
  ADD COLUMN IF NOT EXISTS actual_total_cards INTEGER,
  ADD COLUMN IF NOT EXISTS actual_first_goal_minute INTEGER,
  ADD COLUMN IF NOT EXISTS actual_goal_minutes INTEGER[],
  ADD COLUMN IF NOT EXISTS actual_goal_scorers JSONB;

COMMENT ON COLUMN match_predictions.p_cards_over_25 IS 'P(yellow+red >= 3) en %';
COMMENT ON COLUMN match_predictions.p_cards_over_35 IS 'P(yellow+red >= 4) en %';
COMMENT ON COLUMN match_predictions.p_cards_over_45 IS 'P(yellow+red >= 5) en %';
COMMENT ON COLUMN match_predictions.p_first_goal_30 IS 'P(primer gol antes del minuto 30) en %';
COMMENT ON COLUMN match_predictions.p_first_goal_45 IS 'P(primer gol antes del descanso) en %';
COMMENT ON COLUMN match_predictions.predicted_scorers IS 'Top-N goleadores predichos: [{id, name, prob_pct}]';
COMMENT ON COLUMN match_predictions.actual_total_cards IS 'Total de tarjetas (yellow + red) reales';
COMMENT ON COLUMN match_predictions.actual_first_goal_minute IS 'Minuto del primer gol real (NULL si 0-0)';
COMMENT ON COLUMN match_predictions.actual_goal_minutes IS 'Array de minutos de todos los goles reales';
COMMENT ON COLUMN match_predictions.actual_goal_scorers IS 'Goleadores reales: [{player_id, name, minute}]';
