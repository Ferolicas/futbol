-- Auditoría SOLO LECTURA. No borra filas ni modifica el esquema.
SELECT 'auth_sessions' AS dataset, count(*) AS rows, min(expires_at) AS oldest, max(expires_at) AS newest
FROM public.auth_sessions
UNION ALL
SELECT 'payment_webhook_events', count(*), min(received_at), max(received_at)
FROM public.payment_webhook_events
UNION ALL
SELECT 'match_analysis', count(*), min(created_at), max(created_at)
FROM public.match_analysis
UNION ALL
SELECT 'baseball_match_analysis', count(*), min(created_at), max(created_at)
FROM public.baseball_match_analysis;
