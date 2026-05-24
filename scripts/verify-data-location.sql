-- ─────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN: ¿dónde están los datos de cfanalisis (VPS vs Supabase)?
--
-- Correr ESTE MISMO query en LOS DOS lados y comparar:
--   1) Supabase → SQL Editor del dashboard
--   2) VPS      → PGPASSWORD='TU_PG_PASS' psql -h 127.0.0.1 -p 6432 \
--                   -U cfanalisis -d cfanalisis -f scripts/verify-data-location.sql
--
-- INTERPRETACIÓN:
--   - Si VPS >= Supabase en las tablas críticas (match_analysis,
--     match_predictions, match_results, user_profiles) → datos YA migrados
--     al VPS. NO necesitas dump/restore. Saltas directo a auth (Fase 3).
--   - Si VPS sale 0 / no aparece la tabla / mucho menor → datos en Supabase,
--     SÍ necesitas dump+restore.
--
-- ─────────────────────────────────────────────────────────────────────────

-- OPCIÓN A — Estimación rápida (NUNCA falla, lista solo tablas existentes).
-- n_live_tup es el estimado del planner; suficiente para comparar lados.
SELECT relname AS tabla, n_live_tup AS filas_aprox
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND relname IN (
    'match_analysis','match_predictions','match_results','match_schedule',
    'fixtures_cache','user_profiles','user_favorites','user_hidden',
    'push_subscriptions','combinadas','combinada_dia','chat_messages',
    'tickets','app_config','users','auth_sessions',
    'baseball_match_analysis','baseball_match_predictions','baseball_match_results'
  )
ORDER BY relname;

-- Si n_live_tup sale desactualizado (p.ej. justo tras un restore sin ANALYZE),
-- corré primero  ANALYZE;  y repetí el query. O usá la OPCIÓN B de abajo para
-- conteos EXACTOS tabla por tabla (descomentar; aborta si una no existe):

-- SELECT 'match_analysis' t, count(*) c FROM match_analysis
-- UNION ALL SELECT 'match_predictions', count(*) FROM match_predictions
-- UNION ALL SELECT 'match_results', count(*) FROM match_results
-- UNION ALL SELECT 'user_profiles', count(*) FROM user_profiles
-- ORDER BY t;
