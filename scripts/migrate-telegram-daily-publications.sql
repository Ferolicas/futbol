BEGIN;

CREATE TABLE IF NOT EXISTS public.telegram_daily_publications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combinada_id        uuid NOT NULL REFERENCES public.combinada_dia(id),
  publication_date    date NOT NULL,
  fixture_id          text NOT NULL,
  telegram_message_id bigint NOT NULL,
  payload             jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  published_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_date,fixture_id)
);

CREATE INDEX IF NOT EXISTS telegram_daily_publications_recent_idx
  ON public.telegram_daily_publications (publication_date DESC);

CREATE TABLE IF NOT EXISTS public.telegram_daily_result_notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES public.telegram_daily_publications(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
  payload        jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  claim_token    uuid,
  claimed_at     timestamptz,
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_id)
);

CREATE INDEX IF NOT EXISTS telegram_daily_result_notifications_queue_idx
  ON public.telegram_daily_result_notifications (status,created_at)
  WHERE status IN ('pending','failed','sending');

COMMENT ON TABLE public.telegram_daily_publications IS
  'Snapshot inmutable de cada opción/partido confirmado por el bot diario de fútbol; única fuente de sus resultados.';
COMMENT ON COLUMN public.telegram_daily_publications.payload IS
  'Contenido exacto enviado con el token de Telegram diario; nunca se reconstruye desde Apuesta del Día.';

GRANT SELECT,INSERT ON public.telegram_daily_publications TO cfanalisis;
GRANT SELECT,INSERT,UPDATE ON public.telegram_daily_result_notifications TO cfanalisis;

COMMIT;
