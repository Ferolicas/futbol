-- CF Analisis - capa durable de pagos y suscripciones.
-- Migracion ADITIVA e idempotente: no elimina ni reescribe datos existentes.
-- Ejecutar antes de desplegar el codigo que consume estas tablas.

BEGIN;

CREATE TABLE IF NOT EXISTS public.payment_attempts (
  id                       uuid PRIMARY KEY,
  user_id                  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider                 text NOT NULL CHECK (provider IN ('stripe', 'mercadopago')),
  kind                     text NOT NULL CHECK (kind IN ('subscription', 'one_time')),
  plan                     text NOT NULL CHECK (plan IN ('semanal', 'mensual', 'trimestral', 'semestral', 'anual')),
  status                   text NOT NULL DEFAULT 'creating' CHECK (status IN (
    'creating', 'requires_payment', 'processing', 'succeeded', 'failed',
    'cancelled', 'expired', 'replaced'
  )),
  amount                   bigint,
  currency                 text,
  provider_customer_id     text,
  provider_resource_id     text,
  provider_payment_id      text,
  last_provider_status     text,
  error_code               text,
  error_message            text,
  activation_email_status text NOT NULL DEFAULT 'pending' CHECK (
    activation_email_status IN ('pending', 'sending', 'sent', 'failed', 'not_required')
  ),
  activation_email_attempts integer NOT NULL DEFAULT 0,
  activation_email_sent_at timestamptz,
  last_reconciled_at       timestamptz,
  expires_at               timestamptz NOT NULL DEFAULT (NOW() + interval '23 hours'),
  completed_at             timestamptz,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT NOW(),
  updated_at               timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_provider_resource_uidx
  ON public.payment_attempts (provider, provider_resource_id)
  WHERE provider_resource_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_open_user_uidx
  ON public.payment_attempts (user_id)
  WHERE status IN ('creating', 'requires_payment', 'processing');

CREATE INDEX IF NOT EXISTS payment_attempts_user_created_idx
  ON public.payment_attempts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_attempts_reconcile_idx
  ON public.payment_attempts (status, last_reconciled_at, created_at)
  WHERE status IN ('creating', 'requires_payment', 'processing', 'failed');

CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  provider          text NOT NULL CHECK (provider IN ('stripe', 'mercadopago')),
  event_id          text NOT NULL,
  event_type        text NOT NULL,
  resource_id       text,
  status            text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  attempts          integer NOT NULL DEFAULT 1,
  error_message     text,
  received_at       timestamptz NOT NULL DEFAULT NOW(),
  processing_at     timestamptz NOT NULL DEFAULT NOW(),
  processed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS payment_webhook_events_failed_idx
  ON public.payment_webhook_events (status, updated_at)
  WHERE status = 'failed';

CREATE TABLE IF NOT EXISTS public.payment_exchange_rates (
  source_currency text NOT NULL,
  target_currency text NOT NULL,
  rate            numeric(24, 10) NOT NULL CHECK (rate > 0),
  observed_at     timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_currency, target_currency)
);

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_payment_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_payment_amount bigint,
  ADD COLUMN IF NOT EXISTS last_payment_currency text;

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_stripe_subscription_uidx
  ON public.user_profiles (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_mp_preapproval_uidx
  ON public.user_profiles (mp_preapproval_id)
  WHERE mp_preapproval_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_profiles_payment_reconcile_idx
  ON public.user_profiles (subscription_reconciled_at)
  WHERE role = 'user'
    AND payment_provider IN ('stripe', 'mercadopago')
    AND subscription_status IN ('active', 'past_due', 'cancelled');

-- El deploy ejecuta migraciones como postgres, mientras Next.js conecta con el
-- rol de aplicacion. Los permisos deben quedar explicitos para tablas nuevas.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.payment_attempts, public.payment_webhook_events, public.payment_exchange_rates
  TO cfanalisis;

COMMIT;
