# Observabilidad

Stack nativo: Prometheus, Node/PostgreSQL/Redis exporters, Blackbox Exporter,
Alertmanager y Grafana. No usa Docker en el VPS.

Todos los puertos administrativos escuchan solo en loopback:

- Grafana: `127.0.0.1:3300`
- Prometheus: `127.0.0.1:9090`
- Alertmanager: `127.0.0.1:9093`
- exporters: `127.0.0.1:9100/9115/9121/9187`

Acceso a Grafana:

```bash
ssh -L 3300:127.0.0.1:3300 vps
```

Usuario `admin`; la contraseña queda en el VPS, modo 0600, en
`/root/.cfanalisis-grafana-admin-password`. No se publica por Caddy.

Las métricas cubren procesos, capacidad, PostgreSQL, Redis, disponibilidad web,
colas, jobs, latencia HTTP, WebSockets, rechazos, backpressure, deltas y edad de
backups. Los IDs de request de Fastify y los job IDs permiten correlacionar
logs; trazado distribuido completo queda como evolución cuando exista un
backend externo de trazas.
