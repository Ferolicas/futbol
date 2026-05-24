# Guía de implementación — Migración a Postgres VPS + activación auth PG

> Ejecutar en orden. Cada bloque indica DÓNDE se corre.
> Conexión PG VPS: pgBouncer `127.0.0.1:6432`, db `cfanalisis`, user `cfanalisis`.
> Define una vez en el VPS para no repetir credenciales:
> ```bash
> export PGCMD="PGPASSWORD='TU_PG_PASSWORD' psql -h 127.0.0.1 -p 6432 -U cfanalisis -d cfanalisis"
> ```

---

## PASO 1 — VERIFICAR DÓNDE ESTÁN LOS DATOS (decide todo lo demás)

Corre el MISMO query en los dos lados y compara:

**En Supabase** (SQL Editor del dashboard): pega el contenido de
`scripts/verify-data-location.sql`.

**En el VPS:**
```bash
cd /apps/futbol
eval "$PGCMD -f scripts/verify-data-location.sql"
```

### Decisión según el resultado:

- **VPS ≥ Supabase** en `match_analysis`, `match_predictions`, `match_results`,
  `user_profiles` → **los datos YA están en el VPS**. SALTA el dump/restore.
  Ve directo al **PASO 3** (solo creas las tablas que falten + auth).

- **VPS en 0 / tabla no aparece / mucho menor** → datos en Supabase.
  Haz **PASO 2** (dump + restore) antes de seguir.

> Si `n_live_tup` se ve raro tras un restore reciente, corre `ANALYZE;` en el
> VPS y repite. O usa la OPCIÓN B (conteo exacto) dentro del .sql.

---

## PASO 2 — Dump + restore (SOLO si el PASO 1 dice que los datos están en Supabase)

### 2.1 Dump desde Supabase (en tu máquina local)
Connection string directa: Supabase → Project Settings → Database →
Connection string → URI (modo "Session", puerto 5432).

```bash
export SUPABASE_DB="postgresql://postgres.[REF]:[PASSWORD]@aws-0-[region].pooler.supabase.com:5432/postgres"

pg_dump "$SUPABASE_DB" --data-only --no-owner --no-privileges \
  --table=public.user_profiles --table=public.user_favorites \
  --table=public.user_hidden --table=public.push_subscriptions \
  --table=public.match_analysis --table=public.match_predictions \
  --table=public.match_results --table=public.match_schedule \
  --table=public.fixtures_cache --table=public.combinada_dia \
  --table=public.combinadas --table=public.chat_messages \
  --table=public.tickets --table=public.app_config \
  --table=public.baseball_match_analysis --table=public.baseball_match_predictions \
  --table=public.baseball_match_results --table=public.baseball_match_schedule \
  --table=public.baseball_fixtures_cache --table=public.baseball_standings_cache \
  --table=public.baseball_user_favorites --table=public.baseball_user_hidden \
  --table=public.baseball_api_calls \
  > supabase_data_dump.sql

scp supabase_data_dump.sql usuario@TU_VPS_IP:/apps/futbol/
```

### 2.2 IMPORTANTE: crear primero el schema (PASO 3), LUEGO restaurar
El dump es `--data-only` (solo INSERTs). Las tablas deben existir antes.
Así que: corre el PASO 3 primero, vuelve aquí, y restaura:

```bash
cd /apps/futbol
eval "$PGCMD -f supabase_data_dump.sql"
# Si hay "duplicate key" en una tabla que el VPS ya tenía poblada:
#   - O truncas esa tabla antes (TRUNCATE tabla;) y reintentas,
#   - O quitas esa tabla del dump.
eval "$PGCMD -c 'ANALYZE;'"
```

---

## PASO 3 — Crear el schema que falte en el VPS

### 3.A Migraciones PG-SAFE — correr SIEMPRE (idempotentes, sin RLS)
```bash
cd /apps/futbol

# Tablas nuevas tickets/chat_messages/combinadas (PG puro, sin auth.uid)
eval "$PGCMD -f scripts/migrate-tables-postgres.sql"

# Auth: users + auth_sessions + trigger + view
eval "$PGCMD -f scripts/migrate-auth.sql"

# Tablas auxiliares PG-safe
eval "$PGCMD -f scripts/migrate-audit-logs.sql"
eval "$PGCMD -f scripts/migrate-referee-stats.sql"
eval "$PGCMD -f scripts/migrate-combinada-dia.sql"
```

### 3.B Migraciones ALTER — añaden columnas a tablas existentes (idempotentes)
> Solo funcionan si las tablas base (match_predictions, match_analysis,
> user_profiles, baseball_match_analysis) YA existen en el VPS — que es el
> caso si el PASO 1 mostró datos. Si el VPS estaba vacío, primero restaura
> (PASO 2) o crea las base con 3.C.
```bash
eval "$PGCMD -f scripts/migrate-predictions-full.sql"
eval "$PGCMD -f scripts/migrate-cards-goals-calibration.sql"
eval "$PGCMD -f scripts/migrate-live-stats-column.sql"
eval "$PGCMD -f scripts/migrate-plans-v2.sql"
eval "$PGCMD -f scripts/migrate-baseball-v2.sql"
```

### 3.C Tablas base — SOLO si el PASO 1 mostró que NO existen en el VPS
> ⚠️ Estos `.sql` fueron escritos para Supabase: traen `ENABLE ROW LEVEL
> SECURITY`, `CREATE POLICY ... auth.uid()` y `TO service_role`. En PG puro
> el rol `service_role` y la función `auth.uid()` NO existen → FALLAN.
>
> Si necesitas estas tablas en el VPS (caso raro: VPS vacío), NO corras estos
> archivos tal cual. Pídeme que te genere las versiones PG-puras de:
>   - supabase-schema.sql      → user_profiles, user_favorites, user_hidden, push_subscriptions
>   - create-predictions-table.sql → match_predictions
>   - migrate-baseball-tables.sql  → baseball_* (tiene RLS service_role)
>   - migrate-new-tables.sql       → (ya reemplazado por migrate-tables-postgres.sql)
>
> Lo más probable es que NO necesites 3.C porque el VPS ya tiene estas tablas
> (la app las lee vía pgAdmin y funciona).

### Verificar el schema final
```bash
eval "$PGCMD -c '\dt'"
eval "$PGCMD -c 'SELECT count(*) FROM users; SELECT count(*) FROM auth_sessions;'"
```

---

## PASO 4 — Migrar usuarios de Supabase Auth → tabla users

> En el VPS. Necesita `SUPABASE_SERVICE_ROLE_KEY` y `DATABASE_URL` en `.env`.
> Copia los ~63 usuarios conservando sus UUIDs (para que user_profiles,
> favorites, etc. sigan matcheando). `password_hash` queda NULL → cada usuario
> usa "olvidé mi contraseña" la primera vez.

```bash
cd /apps/futbol
node --env-file=.env scripts/migrate-supabase-users-to-pg.js
eval "$PGCMD -c 'SELECT count(*) FROM users;'"   # ~63
```

---

## PASO 5 — Variables de entorno en el VPS

Editar `/apps/futbol/.env`:
```bash
AUTH_PROVIDER=pg                                  # CRÍTICO: activa auth PG
AUTH_JWT_SECRET=<openssl rand -base64 48>         # firma de los JWT de sesión
# DATABASE_URL ya debe existir (127.0.0.1:6432)
# NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY: NO borrar todavía —
#   el script del PASO 4 las usa. Quitar solo en el PASO 7 (limpieza).
```
Generar el secret:
```bash
openssl rand -base64 48
```

---

## PASO 6 — Rebuild + restart

```bash
cd /apps/futbol
git pull origin main
npm install
npm run build
pm2 restart cfanalisis
pm2 restart cfanalisis-worker
pm2 logs --lines 50
```

---

## PASO 7 — Verificación funcional

1. **Registro nuevo** (`/sign-up`) → entra logueado a `/planes`.
2. **Login usuario migrado** (`/sign-in` con email viejo) → "cuenta migrada,
   usa olvidé contraseña" → `/forgot-password` → email → reset → login OK.
3. **Email**: confirmar llegada del reset. Si no llega: `pm2 logs | grep ZeptoMail`,
   revisar `ZEPTOMAIL_API_KEY` y dominio verificado en ZeptoMail.
4. **Multi-dispositivo**: login en 2 navegadores, ambos OK.
5. **Dashboard** carga fixtures + análisis.
6. **Cuota 1.20**: no aparecen picks < 1.20.
7. **Live ligas exóticas**: partido en vivo Ucrania/China/Serbia → corners/tarjetas
   se actualizan (`pm2 logs | grep "stats rescue"`).

---

## PASO 8 — Limpieza final (1 semana después, tras confirmar estabilidad)

```bash
cd /apps/futbol
npm uninstall @supabase/ssr @supabase/supabase-js
# Comentar NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY en .env
npm run build && pm2 restart cfanalisis
```
> Tras desinstalar @supabase/*, forzar AUTH_PROVIDER=supabase romperá el build
> (intencional — no hay vuelta atrás sin reinstalar).

---

## Listado COMPLETO de migraciones (referencia)

| Archivo | Tipo | ¿Correr en VPS? |
|---------|------|-----------------|
| `migrate-tables-postgres.sql` | PG-puro: tickets, chat_messages, combinadas | ✅ SIEMPRE |
| `migrate-auth.sql` | PG-puro: users, auth_sessions, trigger, view | ✅ SIEMPRE |
| `migrate-audit-logs.sql` | PG-puro: audit_logs | ✅ SIEMPRE |
| `migrate-referee-stats.sql` | PG-puro: referee_stats + función | ✅ SIEMPRE |
| `migrate-combinada-dia.sql` | PG-puro: combinada_dia | ✅ SIEMPRE |
| `migrate-predictions-full.sql` | ALTER match_predictions (+columnas) | ✅ si existe la tabla |
| `migrate-cards-goals-calibration.sql` | ALTER match_predictions | ✅ si existe la tabla |
| `migrate-live-stats-column.sql` | ALTER match_analysis | ✅ si existe la tabla |
| `migrate-plans-v2.sql` | ALTER user_profiles | ✅ si existe la tabla |
| `migrate-baseball-v2.sql` | ALTER baseball_match_analysis | ✅ si existe la tabla |
| `supabase-schema.sql` | RLS/auth.uid: user_profiles, favorites, hidden, push_subscriptions | ❌ Supabase only |
| `create-predictions-table.sql` | RLS: match_predictions | ❌ Supabase only |
| `migrate-baseball-tables.sql` | RLS service_role: baseball_* | ❌ Supabase only |
| `migrate-new-tables.sql` | RLS auth.uid (reemplazado por migrate-tables-postgres) | ❌ Supabase only |
| `verify-data-location.sql` | Solo SELECT de conteos | ▶️ diagnóstico (ambos lados) |

> Los ❌ "Supabase only" NO se corren en el VPS porque usan `auth.uid()`,
> `ENABLE ROW LEVEL SECURITY` y `TO service_role`, que no existen en PG puro.
> Sus tablas o ya están en el VPS, o se llenan vía el dump del PASO 2.

---

## Calibración (independiente)
```bash
cd /apps/futbol
node --env-file=.env scripts/build-calibration.js
```

## Commits de hoy
| Commit | Contenido |
|--------|-----------|
| f7ff0a8 | Worker: fix stalls + pérdida análisis post-medianoche |
| 9c655fe | Notificaciones automáticas al marcar favorito + 7 tipos |
| 46cdfe8 | P1,P2,P4,P6,P7,P8,P9 |
| cec8097 | fix build (cierre memo) |
| 26cc1fe | P5 — Supabase eliminado del codepath, auth 100% PG |
| 96e0d58 | P3 — tournament-predict en combinadas |
| fe52645 | guía migración (v1) |
