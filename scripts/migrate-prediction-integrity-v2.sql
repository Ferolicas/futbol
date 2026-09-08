BEGIN;

CREATE TABLE IF NOT EXISTS public.prediction_runs (
  id BIGSERIAL PRIMARY KEY,
  sport TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  horizon TEXT NOT NULL CHECK (horizon IN ('early','probable-lineup','confirmed-lineup','unknown')),
  predicted_at TIMESTAMPTZ NOT NULL,
  kickoff TIMESTAMPTZ NOT NULL,
  data_cutoff TIMESTAMPTZ NOT NULL,
  model_version TEXT,
  analysis_version INTEGER,
  data_quality JSONB,
  payload_hash TEXT NOT NULL,
  feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  probabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  odds_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prediction_runs_cutoff_before_kickoff CHECK (data_cutoff < kickoff),
  CONSTRAINT prediction_runs_predicted_before_kickoff CHECK (predicted_at < kickoff),
  CONSTRAINT prediction_runs_identity UNIQUE (sport, fixture_id, horizon, payload_hash)
);

CREATE INDEX IF NOT EXISTS prediction_runs_fixture_idx
  ON public.prediction_runs (sport, fixture_id, predicted_at DESC);
CREATE INDEX IF NOT EXISTS prediction_runs_kickoff_idx
  ON public.prediction_runs (sport, kickoff DESC);

CREATE TABLE IF NOT EXISTS public.prediction_market_outputs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.prediction_runs(id) ON DELETE RESTRICT,
  market_key TEXT NOT NULL,
  market_family TEXT,
  probability_raw DOUBLE PRECISION,
  probability_calibrated DOUBLE PRECISION,
  confidence DOUBLE PRECISION,
  sample_n INTEGER,
  validation_status TEXT,
  validation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  offered_odd DOUBLE PRECISION,
  bookmaker TEXT,
  market_fair_probability DOUBLE PRECISION,
  expected_value DOUBLE PRECISION,
  is_recommendation BOOLEAN NOT NULL DEFAULT FALSE,
  rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prediction_market_outputs_probability_raw CHECK (probability_raw IS NULL OR probability_raw BETWEEN 0 AND 1),
  CONSTRAINT prediction_market_outputs_probability_calibrated CHECK (probability_calibrated IS NULL OR probability_calibrated BETWEEN 0 AND 1),
  CONSTRAINT prediction_market_outputs_unique UNIQUE (run_id, market_key)
);

CREATE INDEX IF NOT EXISTS prediction_market_outputs_family_idx
  ON public.prediction_market_outputs (market_family, validation_status, created_at DESC);
CREATE INDEX IF NOT EXISTS prediction_market_outputs_recommendation_idx
  ON public.prediction_market_outputs (is_recommendation, created_at DESC);

CREATE TABLE IF NOT EXISTS public.prediction_settlements (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.prediction_runs(id) ON DELETE RESTRICT,
  market_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('won','lost','push','void','unsettled')),
  result_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_hash TEXT NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settlement_version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT prediction_settlements_history UNIQUE (run_id, market_key, result_hash)
);

CREATE INDEX IF NOT EXISTS prediction_settlements_run_idx
  ON public.prediction_settlements (run_id, settled_at DESC);

-- La inmutabilidad se hace cumplir en PostgreSQL, no solo por convención del
-- código. Una corrección se representa con una fila nueva en settlements.
CREATE OR REPLACE FUNCTION public.prevent_prediction_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prediction history is append-only (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS prediction_runs_append_only ON public.prediction_runs;
CREATE TRIGGER prediction_runs_append_only
BEFORE UPDATE OR DELETE ON public.prediction_runs
FOR EACH ROW EXECUTE FUNCTION public.prevent_prediction_history_mutation();

DROP TRIGGER IF EXISTS prediction_market_outputs_append_only ON public.prediction_market_outputs;
CREATE TRIGGER prediction_market_outputs_append_only
BEFORE UPDATE OR DELETE ON public.prediction_market_outputs
FOR EACH ROW EXECUTE FUNCTION public.prevent_prediction_history_mutation();

DROP TRIGGER IF EXISTS prediction_settlements_append_only ON public.prediction_settlements;
CREATE TRIGGER prediction_settlements_append_only
BEFORE UPDATE OR DELETE ON public.prediction_settlements
FOR EACH ROW EXECUTE FUNCTION public.prevent_prediction_history_mutation();

CREATE TABLE IF NOT EXISTS public.prediction_data_quarantine (
  id BIGSERIAL PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_pk TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload JSONB NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  CONSTRAINT prediction_data_quarantine_unique UNIQUE (source_table, source_pk, reason)
);

CREATE INDEX IF NOT EXISTS prediction_data_quarantine_pending_idx
  ON public.prediction_data_quarantine (detected_at DESC) WHERE resolved_at IS NULL;

DO $grant_prediction_integrity$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['cfanalisis','cfanalisis_staging'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format(
        'GRANT SELECT,INSERT ON public.prediction_runs,public.prediction_market_outputs,public.prediction_settlements TO %I',
        role_name
      );
      EXECUTE format(
        'GRANT SELECT,INSERT,UPDATE ON public.prediction_data_quarantine TO %I',
        role_name
      );
      EXECUTE format(
        'GRANT USAGE,SELECT ON SEQUENCE public.prediction_runs_id_seq,public.prediction_market_outputs_id_seq,public.prediction_settlements_id_seq,public.prediction_data_quarantine_id_seq TO %I',
        role_name
      );
    END IF;
  END LOOP;
END
$grant_prediction_integrity$;

-- Conserva una copia auditable y retira exclusivamente hechos cuya identidad
-- de equipo/rival contradice el fixture. Esos registros no pueden formar parte
-- de ninguna muestra válida del motor.
INSERT INTO public.prediction_data_quarantine(source_table, source_pk, reason, payload)
SELECT 'model.team_match_stats', concat(t.fixture_id, ':', t.team_id),
       'team_or_opponent_not_fixture_participant', to_jsonb(t)
FROM model.team_match_stats t
JOIN model.matches m ON m.fixture_id=t.fixture_id
WHERE t.team_id NOT IN (m.home_team_id,m.away_team_id)
   OR t.opponent_id IS NULL
   OR (t.team_id=m.home_team_id AND t.opponent_id<>m.away_team_id)
   OR (t.team_id=m.away_team_id AND t.opponent_id<>m.home_team_id)
ON CONFLICT (source_table,source_pk,reason) DO NOTHING;

DELETE FROM model.team_match_stats t
USING model.matches m
WHERE m.fixture_id=t.fixture_id
  AND (t.team_id NOT IN (m.home_team_id,m.away_team_id)
    OR t.opponent_id IS NULL
    OR (t.team_id=m.home_team_id AND t.opponent_id<>m.away_team_id)
    OR (t.team_id=m.away_team_id AND t.opponent_id<>m.home_team_id));

INSERT INTO public.prediction_data_quarantine(source_table, source_pk, reason, payload)
SELECT 'model.player_match_stats', concat(p.fixture_id, ':', p.player_id),
       'team_or_opponent_not_fixture_participant', to_jsonb(p)
FROM model.player_match_stats p
JOIN model.matches m ON m.fixture_id=p.fixture_id
WHERE p.team_id NOT IN (m.home_team_id,m.away_team_id)
   OR p.opponent_id IS NULL
   OR (p.team_id=m.home_team_id AND p.opponent_id<>m.away_team_id)
   OR (p.team_id=m.away_team_id AND p.opponent_id<>m.home_team_id)
ON CONFLICT (source_table,source_pk,reason) DO NOTHING;

DELETE FROM model.player_match_stats p
USING model.matches m
WHERE m.fixture_id=p.fixture_id
  AND (p.team_id NOT IN (m.home_team_id,m.away_team_id)
    OR p.opponent_id IS NULL
    OR (p.team_id=m.home_team_id AND p.opponent_id<>m.away_team_id)
    OR (p.team_id=m.away_team_id AND p.opponent_id<>m.home_team_id));

INSERT INTO public.prediction_data_quarantine(source_table, source_pk, reason, payload)
SELECT 'model.lineups', concat(l.fixture_id, ':', l.team_id, ':', l.player_id),
       'team_not_fixture_participant', to_jsonb(l)
FROM model.lineups l
JOIN model.matches m ON m.fixture_id=l.fixture_id
WHERE l.team_id NOT IN (m.home_team_id,m.away_team_id)
ON CONFLICT (source_table,source_pk,reason) DO NOTHING;

DELETE FROM model.lineups l
USING model.matches m
WHERE m.fixture_id=l.fixture_id
  AND l.team_id NOT IN (m.home_team_id,m.away_team_id);

INSERT INTO public.prediction_data_quarantine(source_table, source_pk, reason, payload)
SELECT 'model.match_events', e.event_id::text,
       'team_not_fixture_participant', to_jsonb(e)
FROM model.match_events e
JOIN model.matches m ON m.fixture_id=e.fixture_id
WHERE e.team_id IS NOT NULL AND e.team_id NOT IN (m.home_team_id,m.away_team_id)
ON CONFLICT (source_table,source_pk,reason) DO NOTHING;

DELETE FROM model.match_events e
USING model.matches m
WHERE m.fixture_id=e.fixture_id
  AND e.team_id IS NOT NULL AND e.team_id NOT IN (m.home_team_id,m.away_team_id);

INSERT INTO public.prediction_data_quarantine(source_table, source_pk, reason, payload)
SELECT 'model.match_injuries', i.injury_id::text,
       'team_not_fixture_participant', to_jsonb(i)
FROM model.match_injuries i
JOIN model.matches m ON m.fixture_id=i.fixture_id
WHERE i.team_id NOT IN (m.home_team_id,m.away_team_id)
ON CONFLICT (source_table,source_pk,reason) DO NOTHING;

DELETE FROM model.match_injuries i
USING model.matches m
WHERE m.fixture_id=i.fixture_id
  AND i.team_id NOT IN (m.home_team_id,m.away_team_id);

COMMIT;
