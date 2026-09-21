BEGIN;

CREATE TABLE IF NOT EXISTS public.prediction_seal_batches (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'FreeTSA',
  provider_url TEXT NOT NULL DEFAULT 'https://freetsa.org/tsr',
  hash_algorithm TEXT NOT NULL DEFAULT 'SHA-512' CHECK (hash_algorithm='SHA-512'),
  merkle_root TEXT NOT NULL UNIQUE CHECK (merkle_root ~ '^[0-9a-f]{128}$'),
  leaf_count INTEGER NOT NULL CHECK (leaf_count BETWEEN 1 AND 32),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sealed','failed','invalid')),
  request_tsq BYTEA,
  response_tsr BYTEA,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  submitted_at TIMESTAMPTZ,
  tsa_time TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  certificate_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prediction_seal_batch_artifacts CHECK (
    status <> 'sealed' OR (request_tsq IS NOT NULL AND response_tsr IS NOT NULL AND verified_at IS NOT NULL AND tsa_time IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS prediction_seal_batches_due_idx
  ON public.prediction_seal_batches(next_attempt_at,created_at)
  WHERE status IN ('pending','failed');

CREATE TABLE IF NOT EXISTS public.prediction_seal_proofs (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  run_id BIGINT NOT NULL REFERENCES public.prediction_runs(id) ON DELETE RESTRICT,
  market_output_id BIGINT NOT NULL REFERENCES public.prediction_market_outputs(id) ON DELETE RESTRICT,
  batch_id BIGINT REFERENCES public.prediction_seal_batches(id) ON DELETE RESTRICT,
  canonical_payload BYTEA NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{128}$'),
  leaf_index INTEGER,
  merkle_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sealed','failed','invalid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prediction_seal_proof_output_unique UNIQUE (market_output_id),
  CONSTRAINT prediction_seal_proof_membership CHECK (
    status NOT IN ('sealed','invalid') OR (batch_id IS NOT NULL AND leaf_index IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS prediction_seal_proofs_pending_idx
  ON public.prediction_seal_proofs(created_at) WHERE status='pending' AND batch_id IS NULL;
CREATE INDEX IF NOT EXISTS prediction_seal_proofs_run_idx
  ON public.prediction_seal_proofs(run_id,status,created_at DESC);

DO $grant_prediction_seals$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['cfanalisis','cfanalisis_staging'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.prediction_seal_batches,public.prediction_seal_proofs TO %I', role_name);
      EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE public.prediction_seal_batches_id_seq,public.prediction_seal_proofs_id_seq TO %I', role_name);
    END IF;
  END LOOP;
END
$grant_prediction_seals$;

COMMIT;
