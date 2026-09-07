# Preparación para failover

Con el VPS actual no existe alta disponibilidad física. La aplicación sí queda
preparada para reducir el tiempo de migración:

- deploy reproducible desde `main` y releases inmutables;
- servicios solo en loopback detrás de Caddy;
- estado durable en PostgreSQL/Redis y copias externas verificables;
- health checks, inventario de puertos y runbooks de restauración;
- staging sin datos LIVE para validar una release antes de producción.

Cuando haya presupuesto, la ruta mínima es PostgreSQL gestionado con réplica y
backups PITR, Redis gestionado con réplica, segundo runtime web/worker y un
balanceador/health check externo. Antes de conmutar se debe probar pérdida de
un nodo, consistencia de BullMQ, WebSocket reconnect y reconciliación de pagos.
