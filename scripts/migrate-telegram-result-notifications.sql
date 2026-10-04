BEGIN;

CREATE TABLE IF NOT EXISTS public.telegram_result_notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combinada_id  uuid NOT NULL REFERENCES public.combinada_dia(id) ON DELETE CASCADE,
  fixture_id    bigint NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sending','sent','failed')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token   uuid,
  claimed_at    timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (combinada_id,fixture_id)
);

CREATE INDEX IF NOT EXISTS telegram_result_notifications_queue_idx
  ON public.telegram_result_notifications (status,created_at)
  WHERE status IN ('pending','sending','failed');

COMMENT ON TABLE public.telegram_result_notifications IS
  'Cola durable e idempotente de resultados de las opciones publicadas en Telegram.';
COMMENT ON COLUMN public.telegram_result_notifications.payload IS
  'Snapshot exacto confirmado por Telegram y, después, su won/lost ya persistido por la web; aquí no se recalcula.';

GRANT SELECT,INSERT,UPDATE,DELETE
  ON public.telegram_result_notifications TO cfanalisis;

-- No inundar el canal con partidos que ya habían finalizado antes de activar
-- esta automatización. Se registran como entregados sin alterar combinada_dia.
INSERT INTO public.telegram_result_notifications
  (combinada_id,fixture_id,status,payload,sent_at)
SELECT DISTINCT d.id,(pick.match->>'fixtureId')::bigint,'sent',
  jsonb_build_object('bootstrap',true,'fixtureId',(pick.match->>'fixtureId')::bigint),now()
FROM public.combinada_dia d
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(d.selections)='array' THEN d.selections ELSE '[]'::jsonb END
) pick(match)
WHERE pick.match ? 'fixtureId'
  AND EXISTS (
    SELECT 1 FROM public.match_results mr
    WHERE mr.fixture_id=(pick.match->>'fixtureId')::bigint
      AND upper(COALESCE(mr.status->>'short','')) IN ('FT','AET','PEN','AWD','WO')
  )
ON CONFLICT (combinada_id,fixture_id) DO NOTHING;

COMMIT;
