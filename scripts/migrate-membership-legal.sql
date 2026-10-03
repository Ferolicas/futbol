-- Membresias con vencimiento real + evidencia legal verificable.
-- Aditiva e idempotente. No fabrica aceptaciones para usuarios existentes.
BEGIN;

CREATE TABLE IF NOT EXISTS public.legal_acceptances (
  id                          bigserial PRIMARY KEY,
  user_id                     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  document_set_version        text NOT NULL,
  terms_version               text NOT NULL,
  privacy_version             text NOT NULL,
  cookies_version             text NOT NULL,
  terms_accepted              boolean NOT NULL DEFAULT false,
  privacy_acknowledged        boolean NOT NULL DEFAULT false,
  data_processing_authorized  boolean NOT NULL DEFAULT false,
  age_confirmed               boolean NOT NULL DEFAULT false,
  acceptance_source           text NOT NULL CHECK (acceptance_source IN ('web', 'mobile', 'registration-web', 'registration-mobile')),
  accepted_at                 timestamptz NOT NULL,
  ip_hash                     text,
  user_agent_hash             text,
  evidence_hash               text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, document_set_version),
  UNIQUE (evidence_hash)
);

CREATE INDEX IF NOT EXISTS legal_acceptances_user_accepted_idx
  ON public.legal_acceptances (user_id, accepted_at DESC);

GRANT SELECT, INSERT ON public.legal_acceptances TO cfanalisis;
GRANT USAGE, SELECT ON SEQUENCE public.legal_acceptances_id_seq TO cfanalisis;

-- Historial inmutable: la preferencia vigente siempre es el ultimo evento.
CREATE TABLE IF NOT EXISTS public.marketing_consent_events (
  id               bigserial PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  action           text NOT NULL CHECK (action IN ('consent', 'withdrawal')),
  policy_version   text NOT NULL,
  source           text NOT NULL CHECK (source IN ('web', 'mobile', 'registration-web', 'registration-mobile', 'email')),
  occurred_at      timestamptz NOT NULL,
  ip_hash          text,
  user_agent_hash  text,
  evidence_hash    text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS marketing_consent_events_user_current_idx
  ON public.marketing_consent_events (user_id, occurred_at DESC, id DESC);

GRANT SELECT, INSERT ON public.marketing_consent_events TO cfanalisis;
GRANT USAGE, SELECT ON SEQUENCE public.marketing_consent_events_id_seq TO cfanalisis;

CREATE TABLE IF NOT EXISTS public.marketing_campaigns (
  id             uuid PRIMARY KEY,
  subject        text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 140),
  message        text NOT NULL CHECK (char_length(message) BETWEEN 10 AND 5000),
  cta_label      text,
  cta_url        text,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'completed', 'completed_with_errors')),
  created_by     uuid NOT NULL REFERENCES public.users(id),
  recipient_count integer NOT NULL DEFAULT 0,
  sent_count     integer NOT NULL DEFAULT 0,
  failed_count   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  completed_at   timestamptz
);

CREATE TABLE IF NOT EXISTS public.marketing_campaign_deliveries (
  campaign_id    uuid NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts       integer NOT NULL DEFAULT 0,
  provider_id    text,
  error_message  text,
  updated_at     timestamptz NOT NULL DEFAULT NOW(),
  sent_at        timestamptz,
  PRIMARY KEY (campaign_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.marketing_campaign_assets (
  id            uuid PRIMARY KEY,
  campaign_id   uuid NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  disposition   text NOT NULL CHECK (disposition IN ('inline', 'attachment')),
  content_id    text,
  content       bytea NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS marketing_campaign_deliveries_queue_idx
  ON public.marketing_campaign_deliveries (status, updated_at)
  WHERE status IN ('pending', 'sending', 'failed');

GRANT SELECT, INSERT, UPDATE ON public.marketing_campaigns, public.marketing_campaign_deliveries, public.marketing_campaign_assets TO cfanalisis;

-- Las asignaciones manuales antiguas conservan su fecha de inicio real pero
-- reciben el vencimiento correspondiente al plan que se eligio.
UPDATE public.user_profiles
SET plan_expires_at = COALESCE(plan_started_at, last_payment_at, created_at)
    + CASE plan
        WHEN 'semanal' THEN interval '7 days'
        WHEN 'mensual' THEN interval '30 days'
        WHEN 'trimestral' THEN interval '90 days'
        WHEN 'semestral' THEN interval '180 days'
        WHEN 'anual' THEN interval '365 days'
      END,
    subscription_current_period_end = COALESCE(plan_started_at, last_payment_at, created_at)
    + CASE plan
        WHEN 'semanal' THEN interval '7 days'
        WHEN 'mensual' THEN interval '30 days'
        WHEN 'trimestral' THEN interval '90 days'
        WHEN 'semestral' THEN interval '180 days'
        WHEN 'anual' THEN interval '365 days'
      END,
    updated_at = NOW()
WHERE role = 'user'
  AND subscription_status IN ('active', 'trialing')
  AND plan IN ('semanal', 'mensual', 'trimestral', 'semestral', 'anual')
  AND payment_provider IS NULL
  AND stripe_subscription_id IS NULL
  AND mp_preapproval_id IS NULL
  AND COALESCE(subscription_current_period_end, plan_expires_at) IS NULL;

UPDATE public.user_profiles
SET subscription_status = 'inactive', plan = 'free', cancel_at_period_end = false, updated_at = NOW()
WHERE role = 'user'
  AND (
    subscription_status = 'past_due'
    OR (
      subscription_status IN ('active', 'trialing', 'cancelled')
      AND (
        COALESCE(subscription_current_period_end, plan_expires_at) <= NOW()
        OR COALESCE(subscription_current_period_end, plan_expires_at) IS NULL
      )
    )
    OR (subscription_status = 'cancelled' AND cancel_at_period_end = false)
  );

UPDATE public.user_profiles
SET plan = 'free', updated_at = NOW()
WHERE role = 'user' AND subscription_status = 'inactive' AND plan IS DISTINCT FROM 'free';

-- Corrige el unico abuso historico observado y cualquier otro valor fuera del
-- nuevo limite sin almacenar ni repetir el contenido ofensivo.
UPDATE public.users SET display_name = 'Usuario'
WHERE char_length(COALESCE(display_name, '')) > 60;
UPDATE public.user_profiles SET name = 'Usuario', updated_at = NOW()
WHERE char_length(COALESCE(name, '')) > 60;

CREATE INDEX IF NOT EXISTS user_profiles_inactive_payment_reconcile_idx
  ON public.user_profiles (subscription_reconciled_at)
  WHERE role = 'user'
    AND payment_provider IN ('stripe', 'mercadopago')
    AND subscription_status = 'inactive';

COMMIT;
