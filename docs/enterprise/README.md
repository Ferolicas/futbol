# CF Análisis · operación enterprise

Este directorio convierte los controles técnicos en procedimientos repetibles.
La implementación actual cubre todo lo que puede resolverse con código y con el
VPS existente; la tolerancia a la pérdida física del host sigue necesitando una
segunda máquina o servicios gestionados.

| Área | Estado | Evidencia |
|---|---|---|
| VPS como punto único de fallo | Preparado, no resuelto físicamente | `FAILOVER-READINESS.md`, backups externos |
| PostgreSQL/Redis HA | Persistencia y restauración verificadas; sin failover automático | `DISASTER-RECOVERY.md` |
| Métricas, SLO y alertas | Implantado | Prometheus, Grafana, Alertmanager, `SLO.md` |
| Simulacros de restore | Implantado mensualmente | `scripts/vps/restore_drill.sh` |
| Staging separado | Implantado lógicamente y privado | `STAGING.md` |
| Archivos grandes y tipado | Mejora incremental | worker estricto; deuda registrada en `PROJECT-MAP.md` |
| Carga, DAST y escaneo continuo | Implantado en GitHub Actions | workflows `security`, `dast` y `load` |
| Secretos, retención e incidentes | Formalizado | runbooks de este directorio |

Controles que no deben confundirse con alta disponibilidad:

- Dos procesos PM2 protegen de un fallo de proceso, no de la pérdida del VPS.
- AOF/RDB y `pg_dump` protegen datos, pero no hacen failover automático.
- Alertmanager dentro del VPS no puede avisar si se pierde toda la máquina; el
  health check externo existente debe mantenerse para ese escenario.
