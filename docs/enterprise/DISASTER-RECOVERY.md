# Recuperación ante desastres

## Objetivos actuales

- PostgreSQL: RPO 24–48 h según disponibilidad del destino externo.
- Redis: RPO 24–48 h. BullMQ y cachés toleran reconstrucción parcial.
- RTO operativo estimado: 4 h si existe un VPS nuevo y acceso a GitHub/Drive.

## Copias

- `pg_backup.sh`: dump lógico diario, validación con `pg_restore --list`, SHA-256,
  7 días locales y 30 remotos.
- `redis_backup.sh`: RDB diario validado, SHA-256, 7 días locales y 14 remotos.
- `offsite_backup_retry.sh`: reintenta cada seis horas sin generar otro dump.
- `restore_drill.sh --run`: restaura en `cfanalisis_restore_drill`, valida tablas
  y elimina exclusivamente esa base efímera.

## Recuperación total

1. Declarar incidente y congelar deploys.
2. Provisionar Ubuntu compatible; instalar PostgreSQL, Redis, Node, Caddy y PM2.
3. Clonar `main` y recuperar secretos desde el almacén del propietario.
4. Descargar el último dump cuyo checksum sea válido.
5. Restaurar PostgreSQL y el RDB/AOF de Redis con los servicios consumidores
   detenidos.
6. Desplegar web y worker; ejecutar health checks y un recorrido de login,
   dashboard y realtime antes de cambiar DNS.
7. Registrar RPO/RTO reales y causa raíz.

No está activado PITR: el clúster PostgreSQL es compartido con otras apps y el
destino Drive actual sufre cuotas. Activar archivado WAL sin un repositorio
fiable y una copia base física daría una falsa sensación de recuperación.
