BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_favorites'
      AND column_name = 'notification_preferences'
  ) THEN
    -- Los favoritos anteriores conservan exactamente sus avisos actuales. La
    -- interfaz nueva obliga a escoger para cada favorito creado desde ahora.
    ALTER TABLE public.user_favorites
      ADD COLUMN notification_preferences TEXT[] NOT NULL DEFAULT ARRAY[
        'goals', 'corners', 'shots', 'shots_on_target', 'cards',
        'penalties', 'substitutions', 'fouls'
      ]::TEXT[];
  END IF;
END
$$;

ALTER TABLE public.user_favorites
  ALTER COLUMN notification_preferences SET DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN public.user_favorites.notification_preferences IS
  'Categorías Web Push elegidas para este partido: goals, corners, shots, shots_on_target, cards, penalties, substitutions, fouls. Vacío = favorito sin avisos.';

COMMIT;
