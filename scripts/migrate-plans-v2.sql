-- Planes v2: amplia el CHECK constraint de user_profiles.plan para aceptar
-- los 5 nuevos IDs de plan (semanal, mensual, trimestral, semestral, anual)
-- conservando los antiguos para usuarios legacy.

ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_plan_check;
ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_plan_check
  CHECK (plan IN ('free','plataforma','asesoria','semanal','mensual','trimestral','semestral','anual'));
