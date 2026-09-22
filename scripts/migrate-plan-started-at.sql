-- CF Analisis — fecha de inicio del plan vigente, distinta de "último pago"
-- (que se pisa en cada renovación). Migracion ADITIVA e idempotente.

BEGIN;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS plan_started_at timestamptz;

-- Backfill best-effort para cuentas ya activas: usa el último pago si existe,
-- si no la fecha de registro. No es exacto para renovaciones viejas, pero es
-- mejor que quedar vacío; de aquí en adelante el código ya lo mantiene bien.
UPDATE public.user_profiles
SET plan_started_at = COALESCE(last_payment_at, created_at)
WHERE plan_started_at IS NULL
  AND subscription_status IN ('active', 'trialing', 'past_due')
  AND plan IS NOT NULL
  AND plan <> 'free';

COMMIT;
