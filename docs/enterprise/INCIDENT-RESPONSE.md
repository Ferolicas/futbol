# Respuesta ante incidentes

## Severidad

- SEV-1: fuga de secretos/datos, pagos incorrectos, takeover o caída total.
- SEV-2: degradación significativa, realtime detenido o backups externos >48 h.
- SEV-3: fallo acotado sin impacto material.

## Procedimiento

1. Confirmar la alerta y nombrar responsable e inicio UTC.
2. Contener: deshabilitar la ruta afectada, revocar secreto o volver a la
   release anterior. No borrar evidencia.
3. Preservar `journalctl`, PM2, Caddy, PostgreSQL y eventos de GitHub Actions.
4. Recuperar y verificar health checks, errores, pagos y realtime.
5. Comunicar solo hechos confirmados; si afecta datos personales, escalar la
   evaluación legal de notificación.
6. En 72 h: causa raíz, línea temporal, impacto, controles fallidos y acciones.

## Primeros comandos seguros

```bash
pm2 list
systemctl --failed
curl -fsS https://cfanalisis.com/api/health
curl -fsS https://worker.cfanalisis.com/health
journalctl --since '-30 minutes' --no-pager
```

Nunca pegar tokens, cookies, bodies de pago o datos personales en incidencias
públicas. La política de reporte está en `SECURITY.md`.
