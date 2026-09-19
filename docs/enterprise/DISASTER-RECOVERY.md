# Recuperación ante desastres

## Objetivos actuales

- PostgreSQL: RPO 24–48 h según disponibilidad del destino externo.
- Redis: RPO 24–48 h. BullMQ y cachés toleran reconstrucción parcial.
- RTO operativo estimado: 4 h si existe un VPS nuevo y acceso a GitHub/Drive.

## Copias

Política del propietario (2026-09-19): **una copia diaria y un día de
redundancia**, sin copias integrales por cada cambio. El único job local es
`/usr/local/sbin/holding-daily-backup backup`, instalado desde
`scripts/vps/holding_daily_backup.py` y ejecutado a las 03:00, hora de Madrid.

- Destino: `/var/backups/holding/YYYY-MM-DD/`. Cada base PostgreSQL se guarda
  una vez en `postgres/<base>.dump`; también se incluyen roles, Redis,
  fuentes/assets/uploads/envs de todas las apps, configuración y Unity activo.
- `COMPLETE.json` contiene hashes SHA-256 e inventario. No se retira la copia
  anterior hasta completar la nueva. Si falla un día, se conserva la última
  copia válida como redundancia. Repetir el comando el mismo día no duplica.
- Se excluyen `node_modules`, `.next`, `.git`, cachés y releases históricas;
  la recuperación de aplicaciones reinstala dependencias desde lockfiles y
  compila. Las copias locales contienen secretos y son privadas de root.
- Los wrappers `pg_backup.sh`, `redis_backup.sh` y `env_backup.sh` reutilizan
  ese mismo job. No programar copias separadas `pg_dumpall` o por aplicación.
- `offsite_backup_retry.sh` reintenta CF Análisis y Redis en el destino externo
  existente, con hoy y ayer. Los archivos de apps/configuración quedan locales;
  no se suben secretos sin cifrado configurado.
- `restore_drill.sh --run` usa `postgres/cfanalisis.dump` del conjunto diario.
- `holding-daily-backup prune-releases --apply` conserva únicamente las releases activas, tras completar la copia diaria, en CF Análisis y Market Unity. Nunca elimina el runtime
  identificado por PM2 o el puntero `current`.

En la migración del 19 de septiembre, el conjunto del 18 conserva el dump
PostgreSQL global y Redis existentes; no había una copia diaria de todas las
apps del día 18. La primera copia consolidada de apps se crea el día 19.

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
