# cfanalisis-worker

BullMQ-backed worker that runs all cron logic for CFanalisis. Replaces the
Vercel function-bound crons under `/app/api/cron/*` — those endpoints are now
thin enqueuers that POST to this worker's HTTP `/enqueue/:queue` endpoint.

## Why this exists

Vercel functions on the free / hobby plan are capped at 300s and cost CPU
seconds. Crons like `futbol-analyze-batch` and `futbol-live` run for minutes,
chain themselves via `waitUntil`, and were brittle on long days. Moving them
to a single Node.js process on a VPS removes the time limit, the chaining,
and the cost variability.

## Architecture

```
cron-job.org  ──GET──▶  Vercel  /api/cron/*
                           │
                           │  POST /enqueue/:queue
                           ▼
                      VPS worker  (this app)
                           │
                  ┌────────┼────────┐
                  ▼        ▼        ▼
              Fastify    BullMQ   Workers
              (HTTP    (queues  (handlers
              :8080)   in local in src/jobs)
                       Redis)
```

- **HTTP server (Fastify, `127.0.0.1:8080`)** — receives enqueue webhooks from
  Vercel, validates `Authorization: Bearer $WORKER_SECRET`, pushes a job to
  the right BullMQ queue, returns 200 immediately. Caddy is the only public
  ingress.
- **WebSocket gateway** — accepts five-minute session JWTs in
  `Sec-WebSocket-Protocol`; it never accepts `WORKER_SECRET` from a browser and
  authorizes every subscription against the token's topic allowlist.
- **BullMQ queues** — one per cron type (15 in total), backed by Redis on
  `127.0.0.1:6379` (local to the VPS). Job retries / backoff / cleanup
  configured in `src/queues.ts`.
- **Workers** — one per queue, registered in `src/workers.ts`. Concurrency
  tuned per queue (1 for time-sensitive crons, 2 for batchy ones).
- **Job handlers** — pure JS in `src/jobs/{futbol,baseball}/*.js`. They
  import the app's own `lib/*` files via relative paths, so business logic
  (api-football wrapper, calibration, combinada, supabase helpers, etc.) is
  shared between Vercel and the worker.

### Two Redis instances

| Redis                              | Used for                                            | Driver           |
| ---------------------------------- | --------------------------------------------------- | ---------------- |
| Local VPS `127.0.0.1:6379`         | BullMQ queues only                                  | `ioredis` (TCP)  |
| Upstash (`UPSTASH_REDIS_REST_*`)   | App cache: fixtures, live, analysis, schedule, etc. | `@upstash/redis` |

Vercel and the worker share the Upstash cache so the dashboard reads
populated keys regardless of which side wrote them.

## Queues

| Queue                       | Schedule (cron-job.org)         | Notes                                   |
| --------------------------- | ------------------------------- | --------------------------------------- |
| `futbol-fixtures`           | `5 0 * * *`                     | Fetch tomorrow's fixtures               |
| `futbol-daily`              | `10 0 * * *`                    | Triggers analyze-batch internally       |
| `futbol-analyze-batch`      | (chained from daily)            | Full-day analysis, no time limit        |
| `futbol-analyze-all-today`  | manual                          | Force-reanalyze all fixtures            |
| `futbol-finalize`           | `0 1,2 * * *`                   | Persist results, close prediction rows  |
| `futbol-cleanup`            | `0 1 * * *`                     | Delete rows older than retention window |
| `futbol-lineups`            | `*/5 * * * *`                   | Smart: only acts T-45min before kickoff |
| `futbol-live`               | every 30 sec                    | Smart: only acts inside game window     |
| `futbol-live-corners`       | `*/30 * * * *`                  | Refresh corners for live matches        |
| `futbol-odds`               | `*/15 * * * *`                  | Vigilancia Bet365/Bwin adaptativa hasta kickoff; vacíos nunca cierran reintentos |
| `baseball-fixtures`         | `20 10 * * *` Colombia          | Fetch MLB fixtures                      |
| `baseball-analyze`          | `30 10 * * *` Colombia          | Compute probs + persist analysis/odds   |
| `baseball-live`             | every 1 min                     | Live + durable final scores/boxscores   |
| `baseball-finalize`         | `0 5,9 * * *` Madrid            | Fill actual_* cols of predictions       |
| `baseball-cleanup`          | `0 3 * * *`                     | Delete stale baseball rows              |

All cron-job.org hits go to `https://cfanalisis.com/api/cron/<name>?secret=$CRON_SECRET`
exactly as before — the Vercel endpoint now enqueues instead of executing.

## Configuration

Copy `.env.example` to `.env` and fill in. Required:

- `WORKER_SECRET` — compartido solo con la web del VPS y Prometheus; nunca con
  el navegador.
- `WORKER_HOST=127.0.0.1` — do not expose Fastify directly to the Internet.
- `REDIS_HOST` / `REDIS_PORT` — local Redis for BullMQ (default 127.0.0.1:6379).
- `DATABASE_URL` — PostgreSQL through local PgBouncer.
- `FOOTBALL_API_KEY`, `BZZOIRO_API_KEY` (baseball), `THE_ODDS_API_KEY`.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.

On the Vercel side, add:

- `WORKER_URL=https://worker.cfanalisis.com`
- `WORKER_SECRET=<same value as on the VPS>`

## Local dev

```bash
cd apps/cfanalisis-worker
npm install
cp .env.example .env   # fill in
npm run dev            # tsx watch
```

The worker depends on a running Redis. On macOS / Linux:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

Hit `http://localhost:8080/health` to check it's up. To enqueue a test job:

```bash
curl -X POST http://localhost:8080/enqueue/futbol-fixtures \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"payload":{"date":"2026-05-12"}}'
```

## VPS deploy (systemd)

```ini
# /etc/systemd/system/cfanalisis-worker.service
[Unit]
Description=cfanalisis worker (BullMQ + Fastify)
After=network.target redis.service
Requires=redis.service

[Service]
Type=simple
User=cfanalisis
WorkingDirectory=/opt/cfanalisis/apps/cfanalisis-worker
EnvironmentFile=/opt/cfanalisis/apps/cfanalisis-worker/.env
ExecStart=/usr/bin/node --import tsx /opt/cfanalisis/apps/cfanalisis-worker/src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cfanalisis-worker
journalctl -u cfanalisis-worker -f
```

Or with pm2:

```bash
pm2 start --name cfanalisis-worker --interpreter tsx src/index.ts
pm2 save && pm2 startup
```

## Observability

- `GET /health` — public minimal status and timestamp only.
- `GET /queues/:name/status` — authenticated with `Authorization: Bearer
  $WORKER_SECRET`; returns `waiting / active / completed / failed / delayed`.
- `GET /admin/status` — authenticated operational detail (queues, DB/Redis,
  memory and WebSocket clients).
- `GET /metrics` — formato Prometheus, también autenticado con
  `Authorization: Bearer $WORKER_SECRET`.
- Standard BullMQ events (`completed`, `failed`, `error`) are logged to stdout.
- Prometheus/Grafana/Alertmanager y exporters se provisionan desde
  `ops/observability/`; todos escuchan solo en loopback.

## Build (optional)

`tsx` runs TS directly — no build needed in production. If you prefer a
compiled artifact:

```bash
npm run build
node dist/index.js
```

El workflow de producción sí compila `dist/` y recarga los procesos realtime y
heavy cuando cambia este directorio o el protocolo compartido.
