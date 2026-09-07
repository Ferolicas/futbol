# Rotación de secretos

| Secreto | Frecuencia | Efecto |
|---|---:|---|
| `WORKER_SECRET` | 90 días o incidente | coordinar web, worker y Prometheus |
| `AUTH_JWT_SECRET` | 180 días o incidente | invalida sesiones salvo transición dual |
| Stripe/MP webhook secrets | anual o incidente | transición desde cada proveedor |
| API deportivas/email | 180 días o incidente | sustituir y probar cuota/envío |
| clave SSH de deploy | 180 días o incidente | cambiar GitHub secret y `authorized_keys` |

Reglas:

1. Generar con CSPRNG; mínimo 32 bytes para secretos internos.
2. Actualizar consumidores de forma coordinada y probar antes de revocar.
3. Nunca mostrar el valor en terminal compartida, logs, commits o tickets.
4. Registrar solo nombre, responsable, fecha y próxima rotación.
5. Tras sospecha de exposición se rota aunque Git haya eliminado el texto.

`WORKER_SECRET` debe ser idéntico en el `.env` web y worker de producción y en
`/etc/prometheus/cfanalisis-worker.token`. Staging usa otro valor.
