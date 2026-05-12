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

- **HTTP server (Fastify, port 8080)** — receives enqueue webhooks from
  Vercel, validates `Authorization: Bearer $WORKER_SECRET`, pushes a job to
  the right BullMQ queue, returns 200 immediately.
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
| `futbol-live`               | `*/1 * * * *`                   | Smart: only acts inside game window     |
| `futbol-live-corners`       | `*/30 * * * *`                  | Refresh corners for live matches        |
| `futbol-odds`               | `*/15 * * * *`                  | Pull odds from The Odds API             |
| `baseball-fixtures`         | `0 1 * * *`                     | Fetch baseball fixtures                 |
| `baseball-analyze`          | `30 1 * * *`                    | Compute probs + persist analysis        |
| `baseball-live`             | `*/5 * * * *`                   | Smart: budgeted + dynamically spaced    |
| `baseball-finalize`         | `0 5 * * *`                     | Fill actual_* cols of predictions       |
| `baseball-cleanup`          | `0 3 * * *`                     | Delete stale baseball rows              |

All cron-job.org hits go to `https://cfanalisis.com/api/cron/<name>?secret=$CRON_SECRET`
exactly as before — the Vercel endpoint now enqueues instead of executing.

## Configuration

Copy `.env.example` to `.env` and fill in. Required:

- `WORKER_SECRET` — shared with Vercel (`WORKER_SECRET` env var there too).
- `REDIS_HOST` / `REDIS_PORT` — local Redis for BullMQ (default 127.0.0.1:6379).
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — app cache.
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — DB access.
- `FOOTBALL_API_KEY`, `BZZOIRO_API_KEY` (baseball), `THE_ODDS_API_KEY`.
- `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER`.
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

- `GET /health` — uptime + queue list.
- `GET /queues/:name/status` — `waiting / active / completed / failed / delayed` counts.
- Standard BullMQ events (`completed`, `failed`, `error`) are logged to stdout.
- For a UI, point Bull Board or Arena at the same Redis on the VPS.

## Build (optional)

`tsx` runs TS directly — no build needed in production. If you prefer a
compiled artifact:

```bash
npm run build
node dist/index.js
```
