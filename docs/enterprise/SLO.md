# SLO y presupuesto de error

Ventana móvil: 30 días. Responsable: propietario de CF Análisis.

| Señal | Objetivo | Medición |
|---|---:|---|
| Disponibilidad web | 99,9% | `probe_success` de `/api/health` |
| Disponibilidad gateway realtime | 99,9% | `up{job="cfanalisis-worker"}` y `/health` |
| Errores HTTP gateway | <1% | `cfanalisis_http_requests_total{status=~"5.."}` |
| Latencia gateway | p95 <1 s | histograma `cfanalisis_http_request_duration_seconds` |
| Backup PostgreSQL local | RPO ≤30 h | métrica `postgres_local` |
| Backup PostgreSQL externo | RPO ≤48 h | métrica `postgres_offsite` |
| Restauración verificada | cada ≤40 días | métrica `restore_drill` |

Un SLO de 99,9% permite aproximadamente 43 minutos de indisponibilidad al mes.
Si se consume el 50% del presupuesto antes de la mitad de la ventana, se
congelan cambios no urgentes; al 100%, solo entran recuperación y seguridad.

Limitación conocida: las sondas Prometheus internas no detectan la pérdida
completa del VPS. Para esa señal debe existir una sonda externa con alerta a un
canal que no dependa del propio servidor.
