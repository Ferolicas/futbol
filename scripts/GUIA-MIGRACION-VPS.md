# Guía de implementación — Migración a Postgres VPS + activación auth PG

> Ejecutar en orden. Cada bloque indica DÓNDE se corre (VPS shell, psql, o Supabase SQL editor).
> Datos de conexión PG VPS: pgBouncer en `127.0.0.1:6432`, db `cfanalisis`, user `cfanalisis`.

---

## FASE 0 — Backup de seguridad (ANTES DE TODO)

### 0.1 En Supabase (SQL editor) — confirmar qué hay
```sql
SELECT tablename,
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) c FROM %I', tablename), false, true, '')))[1]::text::int AS rows
FROM pg_tables WHERE schemaname='public' ORDER BY rows DESC;
```

### 0.2 Dump COMPLETO de Supabase (opción B — preservar todo)
En tu máquina local (necesitas la connection string directa de Supabase,
NO la de pooler — la encuentras en Supabase → Project Settings → Database →
Connection string → URI, modo "Session"):

```bash
# Reemplaza con tu connection string real de Supabase
export SUPABASE_DB="postgresql://postgres.[REF]:[PASSWORD]@aws-0-[region].pooler.supabase.com:5432/postgres"

# Dump SOLO de datos (schema lo creamos con los migrate-*.sql), todas las tablas críticas
pg_dump "$SUPABASE_DB" \
  --data-only --no-owner --no-privileges \
  --table=public.user_profiles \
  --table=public.user_favorites \
  --table=public.user_hidden \
  --table=public.push_subscriptions \
  --table=public.match_analysis \
  --table=public.match_predictions \
  --table=public.match_results \
  --table=public.match_schedule \
  --table=public.fixtures_cache \
  --table=public.combinada_dia \
  --table=public.combinadas \
  --table=public.chat_messages \
  --table=public.tickets \
  --table=public.app_config \
  --table=public.baseball_match_analysis \
  --table=public.baseball_match_predictions \
  --table=public.baseball_match_results \
  --table=public.baseball_match_schedule \
  --table=public.baseball_fixtures_cache \
  --table=public.baseball_standings_cache \
  --table=public.baseball_user_favorites \
  --table=public.baseball_user_hidden \
  --table=public.baseball_api_calls \
  > supabase_data_dump.sql

# Subir el dump al VPS
scp supabase_data_dump.sql usuario@TU_VPS_IP:/apps/futbol/
```

---

## FASE 1 — Crear schema en el VPS Postgres

> En el VPS shell. La contraseña de PG la tienes en `/apps/futbol/.env` (DATABASE_URL).

```bash
cd /apps/futbol

# Helper para no repetir credenciales (ajusta password)
export PGCMD="PGPASSWORD='TU_PG_PASSWORD' psql -h 127.0.0.1 -p 6432 -U cfanalisis -d cfanalisis"

# 1.1 Tablas de datos (tickets, chat_messages, combinadas)
eval "$PGCMD -f scripts/migrate-tables-postgres.sql"

# 1.2 Auth (users + auth_sessions + trigger + view)
eval "$PGCMD -f scripts/migrate-auth.sql"

# 1.3 El resto de migraciones que tu VPS aún no tenga (idempotentes, seguro re-correr):
eval "$PGCMD -f scripts/migrate-predictions-full.sql"
eval "$PGCMD -f scripts/migrate-referee-stats.sql"
eval "$PGCMD -f scripts/migrate-audit-logs.sql"
eval "$PGCMD -f scripts/migrate-live-stats-column.sql"
eval "$PGCMD -f scripts/migrate-combinada-dia.sql"
eval "$PGCMD -f scripts/migrate-baseball-tables.sql"
```

Verifica que las tablas existan:
```bash
eval "$PGCMD -c '\dt'"
```

---

## FASE 2 — Restaurar datos de Supabase (opción B)

> En el VPS shell. El dump trae INSERTs; las tablas ya existen (Fase 1).

```bash
cd /apps/futbol

# Restaurar. Si alguna tabla ya tenía filas en el VPS, puede haber conflictos
# de PK — en ese caso añade ON CONFLICT manualmente o trunca primero.
eval "PGPASSWORD='TU_PG_PASSWORD' psql -h 127.0.0.1 -p 6432 -U cfanalisis -d cfanalisis -f supabase_data_dump.sql"
```

Si hay errores de "duplicate key" (tablas que el VPS ya tenía pobladas), decide
por tabla: o truncas en el VPS antes de restaurar (`TRUNCATE tabla;`) o saltas
esa tabla del dump. Las críticas que NO debían existir aún en VPS
(match_analysis 1473, match_predictions 912, etc.) deberían entrar limpias.

Verifica conteos post-restore:
```bash
eval "$PGCMD -c 'SELECT count(*) FROM match_analysis; SELECT count(*) FROM match_predictions; SELECT count(*) FROM user_profiles;'"
```

---

## FASE 3 — Migrar usuarios de Supabase Auth → tabla users

> En el VPS shell. Necesita SUPABASE_SERVICE_ROLE_KEY y DATABASE_URL en .env.
> Esto copia los usuarios (emails + UUIDs) conservando los IDs para que
> user_profiles/favorites/etc sigan matcheando. password_hash queda NULL →
> los usuarios usan "olvidé mi contraseña" la primera vez.

```bash
cd /apps/futbol
node --env-file=.env scripts/migrate-supabase-users-to-pg.js
```

Verifica:
```bash
eval "$PGCMD -c 'SELECT count(*) FROM users;'"   # debería dar ~63
```

---

## FASE 4 — Variables de entorno en el VPS

> Editar `/apps/futbol/.env`. Añadir/confirmar:

```bash
# Activar auth PG (CRÍTICO — sin esto sigue intentando Supabase)
AUTH_PROVIDER=pg

# Secret para firmar los JWT de sesión. Generar uno fuerte:
#   openssl rand -base64 48
AUTH_JWT_SECRET=<pega-aqui-un-secret-de-al-menos-32-chars>

# DATABASE_URL ya debe existir (apunta a 127.0.0.1:6432)
# Las env de Supabase (NEXT_PUBLIC_SUPABASE_URL etc.) YA NO se usan en
# runtime, pero NO las borres todavía hasta confirmar que todo va bien.
# El script migrate-supabase-users-to-pg.js SÍ las necesita (Fase 3).
```

Generar el secret:
```bash
openssl rand -base64 48
```

---

## FASE 5 — Rebuild + restart en el VPS

```bash
cd /apps/futbol
git pull origin main           # trae todos los commits de hoy
npm install                    # por si cambió algo
npm run build                  # next build standalone
pm2 restart cfanalisis         # o el nombre de tu proceso Next
pm2 restart cfanalisis-worker  # el worker BullMQ (live stats, análisis)
pm2 logs --lines 50            # verifica que arranca sin errores
```

---

## FASE 6 — Verificación funcional

1. **Registro nuevo**: ir a `/sign-up`, crear cuenta nueva → debe entrar a `/planes` logueado.
2. **Login usuario migrado**: un email viejo (de Supabase) en `/sign-in` → debe decir
   "tu cuenta fue migrada, usa olvidé contraseña". Ir a `/forgot-password`, pedir reset,
   revisar email (ZeptoMail), resetear, luego login normal.
3. **Email**: confirmar que llegó el correo de reset. Si NO llega:
   - Revisar `pm2 logs` buscando `[ZeptoMail]`.
   - Confirmar `ZEPTOMAIL_API_KEY` en .env.
   - Verificar dominio verificado en ZeptoMail (info@cfanalisis.com).
4. **Sesión multi-dispositivo**: login en 2 navegadores → ambos funcionan. Logout en uno
   → el otro sigue (sesiones independientes en auth_sessions).
5. **Dashboard**: abrir `/dashboard`, ver fixtures + análisis.
6. **Cuota 1.20**: confirmar que no aparecen selecciones < 1.20 en recomendaciones.
7. **Live stats ligas exóticas**: durante un partido en vivo de Ucrania/China/Serbia,
   ver que corners/tarjetas se actualizan (revisar `pm2 logs` buscando "stats rescue").

---

## FASE 7 — Limpieza final (SOLO tras confirmar que TODO va bien, ~1 semana después)

```bash
# Desinstalar paquetes Supabase del VPS
cd /apps/futbol
npm uninstall @supabase/ssr @supabase/supabase-js

# Quitar env vars de Supabase del .env (ya no se usan en runtime)
# NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
# (déjalas comentadas por si necesitas re-migrar algo)

npm run build && pm2 restart cfanalisis
```

> NOTA: tras desinstalar @supabase/*, si alguna vez seteas AUTH_PROVIDER=supabase
> el build fallará (el import es lazy pero el paquete no existe). Es intencional:
> ya no hay vuelta atrás a Supabase sin reinstalar.

---

## Calibración (independiente, correr cuando quieras)

P7 cambió el umbral a 1 muestra. Para reconstruir la calibración con los
datos actuales:
```bash
cd /apps/futbol
node --env-file=.env scripts/build-calibration.js
```
Los mercados nuevos (offsides, rojas, líneas amplias) ya aparecerán calibrados
parcialmente desde el primer resultado registrado.

---

## Resumen de qué quedó hecho en código (commits de hoy)

| Commit | Contenido |
|--------|-----------|
| f7ff0a8 | Worker: fix stalls + pérdida análisis post-medianoche |
| 9c655fe | Notificaciones automáticas al marcar favorito + 7 tipos |
| 46cdfe8 | P1,P2,P4,P6,P7,P8,P9 |
| cec8097 | fix build (cierre memo) |
| 26cc1fe | P5 — Supabase eliminado del codepath, auth 100% PG |
| 96e0d58 | P3 — tournament-predict en combinadas |
