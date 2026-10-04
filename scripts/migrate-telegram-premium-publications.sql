BEGIN;

CREATE TABLE IF NOT EXISTS public.telegram_premium_publications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport               text NOT NULL CHECK (sport IN ('football','baseball')),
  publication_date    date NOT NULL,
  fixture_id          text NOT NULL,
  telegram_message_id bigint NOT NULL,
  payload             jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  published_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport,publication_date,fixture_id)
);

CREATE INDEX IF NOT EXISTS telegram_premium_publications_recent_idx
  ON public.telegram_premium_publications (publication_date DESC,sport);

CREATE TABLE IF NOT EXISTS public.telegram_premium_result_notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES public.telegram_premium_publications(id) ON DELETE CASCADE,
  part           integer NOT NULL CHECK (part>=1),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
  payload        jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  claim_token    uuid,
  claimed_at     timestamptz,
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_id,part)
);

CREATE INDEX IF NOT EXISTS telegram_premium_result_notifications_queue_idx
  ON public.telegram_premium_result_notifications (status,created_at)
  WHERE status IN ('pending','failed','sending');

COMMENT ON TABLE public.telegram_premium_publications IS
  'Snapshot inmutable de las opciones Premium cuya entrega confirmó Telegram; única fuente de sus resultados.';
COMMENT ON COLUMN public.telegram_premium_publications.payload IS
  'Partido y opciones exactas enviados al canal Premium; nunca se reconstruyen desde el motor ni desde combinada_dia.';

GRANT SELECT,INSERT ON public.telegram_premium_publications TO cfanalisis;
GRANT SELECT,INSERT,UPDATE ON public.telegram_premium_result_notifications TO cfanalisis;

COMMIT;
