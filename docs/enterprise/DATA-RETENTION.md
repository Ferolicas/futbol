# Retención de datos

| Categoría | Política técnica actual |
|---|---|
| Caché de fixtures/calendario | 7 días; regenerable |
| Análisis y resultados deportivos | se conservan para validar/entrenar modelos |
| Errores realtime en Redis | 7 días o TTL específico |
| Backups PostgreSQL | copia diaria única: hoy y anterior válida; sin duplicados por cambio |
| Backups Redis | dentro del mismo conjunto diario: hoy y anterior válida |
| Métricas Prometheus | 30 días |
| Logs worker/Caddy | rotación local configurada, objetivo 14 días |
| Sesiones expiradas | eliminables; no son historial comercial |
| Pagos/webhooks | conservar según obligación fiscal y contractual aplicable |
| Cuenta y perfil | hasta baja y plazos legales aplicables |

Los jobs automáticos solo eliminan cachés regenerables. El borrado de clientes,
pagos o evidencia contractual requiere una política legal aprobada y un flujo
de solicitud de derechos; no se debe improvisar desde cron.

`scripts/audit-data-retention.sql` es solo lectura y permite revisar volúmenes y
antigüedad sin borrar información.
