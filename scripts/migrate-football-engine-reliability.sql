BEGIN;

-- Fallos de captura viven fuera de raw_api_payloads: un 429, error HTTP o
-- respuesta vacía nunca vuelve a contaminar la fuente de hechos.
CREATE TABLE IF NOT EXISTS api_capture_failures (
  endpoint        text        NOT NULL,
  ref_id          bigint      NOT NULL,
  sub_key         text        NOT NULL DEFAULT '',
  attempts        integer     NOT NULL DEFAULT 1,
  status          text        NOT NULL DEFAULT 'retry'
                              CHECK (status IN ('retry','empty','permanent')),
  last_error      text,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  next_retry_at   timestamptz,
  resolved_at     timestamptz,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (endpoint, ref_id, sub_key)
);
CREATE INDEX IF NOT EXISTS idx_api_capture_failures_retry
  ON api_capture_failures (status, next_retry_at)
  WHERE resolved_at IS NULL;

-- Las migraciones se ejecutan como postgres, mientras web/worker conectan con
-- el rol limitado de la aplicación. Sin este GRANT el ledger existe pero sus
-- lecturas/escrituras fallan en producción.
GRANT SELECT, INSERT, UPDATE, DELETE ON api_capture_failures TO cfanalisis;

-- Consultas del motor: cubre el historial completo de un equipo en orden y
-- evita heap reads para season/opponent/venue al ponderar contexto.
CREATE INDEX IF NOT EXISTS ix_tms_team_kickoff_context
  ON model.team_match_stats (team_id, kickoff DESC)
  INCLUDE (fixture_id, opponent_id, season, is_home, phase, competition_id);

-- La ingesta incremental busca por endpoint+fixture de forma constante.
CREATE INDEX IF NOT EXISTS idx_raw_endpoint_ref_sub
  ON raw_api_payloads (endpoint, ref_id, sub_key);

COMMIT;
