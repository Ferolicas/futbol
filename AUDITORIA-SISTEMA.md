# Auditoría exhaustiva del sistema — CFanalisis

> Generado por Claude. Objetivo: revisar TODO el sistema buscando bugs, errores,
> parches, deuda técnica y latencia añadida por código. Meta de rendimiento:
> que cada capa opere en su **piso físico** (no "1ms global", que es imposible —
> ver nota de física de redes abajo).

## Estado del recorrido (checklist de subsistemas)

- [x] Infra de latencia: `lib/db.js`, `lib/redis.js`, `lib/ratelimit.js`
- [x] Realtime: `lib/realtime.js`, `pusher*.js`, `useWorkerSocket.js`, `wsManager.ts`, `server.ts`
- [x] Middleware + config: `middleware.js`, `next.config.mjs`
- [x] Caché: `lib/sanity-cache.js` (parcial)
- [x] Worker live: `apps/.../jobs/futbol/live.js` (COMPLETO, 1319 líneas) + `baseball/live.js`
- [x] Auth completo: `auth-pg.js`, `auth-session.js`, `supabase-auth.js`, rutas `/api/auth/*` y `/api/auth-pg/*`
- [x] API-Football fetcher: `lib/api-football.js` (COMPLETO, 2073 líneas)
- [x] Rutas API: las 75 (sustanciales leídas enteras + escaneo de auth de todas)
- [x] Frontend: capa de datos/efectos/WS de las 4 páginas grandes (cuerpos JSX = barrido XSS/secretos)
- [x] **NOTIFICACIONES end-to-end**: detección→dedup→bundle→favoritos→envío→Service Worker→telemetría
- [x] Worker: infra COMPLETA (pool/redis/queues/workers/server/schedulers/logger/env-bootstrap/notifier/errors-log) + TODOS los jobs (fútbol + baseball)
- [x] Modelo COMPLETO: `api-football`, `combinada`, `baseball-model`, `context-engine`, `context-probabilities`, `meta-features`, `adn`, `h2h`, `odds-api`, `mlb-stats-api`, `baseball-calibration`, `baseball-features`, `baseball-ml`, `baseball-combinada`, `tournament-bracket`, `descriptive-stats`
- [x] `lib/*` COMPLETO: db, redis, ratelimit, realtime, webpush, auth*, stripe, zeptomail, resend-email, currency, timezone, audit, fetcher, utils, market-labels, leagues, constants, raw-backfill, feature-snapshot, supabase*, analysis-cache
- [x] Scripts: barrido de secretos/SQL destructivo + lectura de los de riesgo (seed-admin, migrate, retry-payments)
- [x] Barrido final: XSS (`dangerouslySetInnerHTML`), fugas de env en cliente, SQL destructivo

**AUDITORÍA COMPLETA (alcance honesto):** todo el código que porta riesgo/lógica leído
línea-por-línea; cola offline (≈28 scripts backfill/training + cuerpos JSX de render) cubierta
con barridos dirigidos. Ver "RESUMEN EJECUTIVO" y la sección "BARRIDO FINAL" abajo.

---

## SEVERIDAD CRÍTICA

### C1 — `WORKER_SECRET` se filtra al navegador (control total del worker)
**Archivos:** `.env.example` (declara `NEXT_PUBLIC_WORKER_SECRET = mismo valor que WORKER_SECRET — viaja al cliente`), `hooks/useWorkerSocket.js:18,69`, `apps/cfanalisis-worker/src/server.ts:14,20-24,271-279`.

El worker usa **un único secreto** (`WORKER_SECRET`) para autenticar TODO:
- `/ws` (WebSocket realtime) — `server.ts:273`
- `/admin/status`, `/admin/retry`, `/admin/calibrate`, `/admin/test-alert` — `requireAuth`
- `/broadcast` (emite eventos a TODOS los clientes) — `server.ts:451`
- `/enqueue/:queue` (encola cualquier job) — `server.ts:461`

El cliente WS se conecta con `NEXT_PUBLIC_WORKER_SECRET`, que **Next.js inyecta en el
bundle JavaScript del navegador**. Cualquier usuario abre DevTools, lee el secreto, y
con él puede: encolar jobs arbitrarios, disparar broadcasts falsos (goles/chat falsos a
todos los usuarios), forzar recalibraciones, reintentar jobs, leer estado admin.
Es escalada de privilegios + posible abuso de cuota de API-Football + posible DoS.

**Fix:** separar el secreto del WS del secreto admin. El WS para clientes debe usar
un **token efímero por sesión** firmado por el backend (JWT corto), validado en el
worker contra el `cf_session` del usuario — NO un secreto global compartido. Las rutas
`/admin/*`, `/enqueue`, `/broadcast` deben exigir el secreto server-only `WORKER_SECRET`
(nunca `NEXT_PUBLIC_`). El frontend nunca debe llamar a `/broadcast` ni `/enqueue`
directo: debe pasar por una API route de Next que valide sesión y use el secreto server-side.

---

## SEVERIDAD ALTA

### A1 — Faltan los headers de seguridad HTTP que el propio CLAUDE.md exige
**Archivo:** `next.config.mjs` (completo, 20 líneas).

No hay `headers()` con `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `Content-Security-Policy` ni `Strict-Transport-Security`. El
`CLAUDE.md` del proyecto (sección 2.3) los marca como **obligatorios "siempre presentes
en next.config.js"**. Sin ellos: clickjacking, MIME-sniffing, sin HSTS.
*(Nota: si Caddy en el VPS inyecta estos headers en el reverse-proxy, queda cubierto —
verificar el Caddyfile. Si no, falta.)*

### A2 — Rate limiting in-memory: no compartido entre procesos
**Archivo:** `lib/ratelimit.js:1-25` (comentario asume "un solo proceso Node en PM2").

El estado vive en un `Map` del proceso. Memory dice que en el VPS corren `cfanalisis-web`
**y** `cfanalisis-worker` por separado, y Next standalone puede escalar a varios workers.
Cualquier escenario multi-proceso hace el rate limit **inconsistente** (cada proceso
cuenta aparte → el límite efectivo se multiplica por el nº de procesos). Para auth/checkout
esto debilita la protección anti-fuerza-bruta. **Fix:** mover a Redis local (ya tienes
ioredis conectado) con un script Lua atómico (INCR + EXPIRE), como el propio comentario
admite que habría que hacer.

### A3 — Doble (triple) mecanismo de realtime en el detalle de partido
**Archivos:** `app/dashboard/analisis/[id]/page.js:154,184,193` + WS (`useWorkerSocket`).

El detalle de partido en vivo hace **a la vez**: (1) suscripción WebSocket, (2) `fetch`
a `/api/live-poll?fixtureId=` con `setInterval(…, 15000)`, y (3) un `setInterval(…, 1000)`
para el reloj. El dashboard principal añade además `setInterval(refreshLiveData, 30000)`
(`page.js:495`) y un SWR `refreshInterval: 60_000` (`page.js:223`). Hay 3 fuentes de
verdad para el mismo dato en vivo → trabajo duplicado, posibles parpadeos/condiciones de
carrera entre el dato del WS y el del poll, y carga extra en Redis/red. **Fix:** el WS
debe ser la única fuente en vivo; el poll HTTP solo como *fallback* activado cuando
`useWorkerSocketState() !== 'connected'`.

---

## SEVERIDAD MEDIA

### M1 — `lib/db.js`: SELECT con count ejecuta 2 queries secuenciales (2× RTT)
**Archivo:** `lib/db.js:280-290`.

Cuando se pide `{ count: 'exact' }`, hace primero `SELECT count(*)` y *después* el
`SELECT` de datos, en serie. Son dos round-trips a Postgres. Se puede resolver en **uno**
con `count(*) OVER()` como columna extra, o ejecutando ambas con `Promise.all` si se
mantienen separadas. En rutas que listan + cuentan, esto duplica la latencia de BD.

### M2 — `lib/db.js`: mini-ORM hecho a mano imitando supabase-js (parche estructural)
**Archivo:** `lib/db.js` (414 líneas).

Es un *drop-in shim* para no reescribir las llamadas `supabaseAdmin.from(...)`. Funciona,
pero: (a) cada query es un round-trip suelto sin pipelining/prepared statements;
(b) reimplementa parcialmente el query-builder → superficie de bugs (ej. `.range()`,
`.not()` con sub-ops, joins NO soportados); (c) `upsert` sin `onConflict` cae a
`DO NOTHING` (landmine ya documentada en memoria). No es urgente reescribir, pero es el
mayor "parche" del sistema y conviene tenerlo mapeado.

### M3 — Capas de compatibilidad no-op (código muerto / parches)
**Archivos:** `lib/pusher.js`, `lib/pusher-client.js`, `lib/use-pusher.js` (shims que
reexportan o devuelven `null`), `lib/sanity-cache.js` (nombre engañoso: ya no toca Sanity,
es Redis+Postgres), `next.config.mjs:14-15` (inyecta `NEXT_PUBLIC_PUSHER_KEY`/`CLUSTER`
hardcodeados aunque Pusher ya no se usa). Latencia: inocuo. Deuda: confunde y arrastra
imports a módulos vacíos. **Fix:** eliminar shims y renombrar `sanity-cache.js` →
`content-cache.js`, actualizando imports.

### M4 — Duplicación de capa de autenticación (CONFIRMADO)
**Archivos:** `/api/auth/login` y `/api/auth-pg/login` **llaman exactamente a la misma**
`loginUser` de `lib/auth-pg.js` → son endpoints duplicados. El frontend usa `/api/auth/*`
(`sign-in/page.js:22`, `providers.js:42`); el set `/api/auth-pg/*` (login, signup, me,
verify-email, forgot/reset) parece **muerto** (verificar que nada lo referencia → borrar).
La memoria del proyecto (`MEMORY.md`) además dice "Auth: Supabase Auth", pero el código
real (`lib/supabase.js:19-24`, `lib/auth-pg.js`, `middleware.js` con cookie `cf_session`)
muestra que **Supabase Auth ya fue eliminado** y todo es PG nativo. La memoria está
desactualizada en este punto.

### M5 — Colisión de nombre: dos `createSupabaseServerClient` distintos
**Archivos:** `lib/supabase.js:53` (devuelve proxy de **datos**, solo `.from/.rpc`) **vs**
`lib/supabase-auth.js:88` (devuelve shim de **auth**, solo `.auth`). Tienen el mismo
nombre exportado pero comportamiento incompatible. Si una ruta importa del módulo
equivocado, `.auth` o `.from` será `undefined` → error en runtime difícil de rastrear.
**Fix:** renombrar a `createPgDataClient()` y `getAuthClient()` respectivamente.

### M6 — `getCurrentUser()` escribe en BD en CADA request autenticado
**Archivo:** `lib/auth-pg.js:202-232`.

Cada llamada hace (1) un `SELECT` con JOIN `auth_sessions⋈users` **y** (2) un `UPDATE
auth_sessions SET last_seen = NOW()` fire-and-forget. Como los layouts protegidos llaman
`getCurrentUser()` en cada navegación, hay un **write a Postgres por cada page-load**.
Sumado al RTT WAN de BD, infla latencia y carga de escritura sin necesidad. **Fix:**
throttle — solo actualizar `last_seen` si el valor actual es más viejo que ~5 min
(condición en el `WHERE`), o moverlo a un buffer en Redis que se vuelque por lotes.

### M7 — `signupUser` dice "en una transacción" pero NO lo es
**Archivo:** `lib/auth-pg.js:89-104`. El INSERT de `users` y el de `user_profiles` son
dos `pgQuery` separados sin `BEGIN/COMMIT`. Si el segundo falla, queda un usuario sin
perfil (estado inconsistente). **Fix:** envolver en transacción real (un cliente del pool
con `BEGIN`…`COMMIT`/`ROLLBACK`).

---

### M8 — `/api/refresh-live`: fetches por fixture en serie
**Archivo:** `app/api/refresh-live/route.js:218,254,368` (`await apiFetchFixture(...)` dentro
de bucles, sin `Promise.all`). Cuando hay N partidos en vivo, las N llamadas a
API-Football se hacen una tras otra → latencia = N × RTT. **Fix:** lotear con
`Promise.all` respetando un límite de concurrencia (p.ej. 5 a la vez) en vez de serie pura.

### M9 — Throttle global de API-Football (latencia inherente, no bug)
**Archivo:** `lib/api-football.js:110,139` (`MIN_DELAY_MS=75`, `_throttleChain`). TODAS las
llamadas a API-Football se serializan por una cadena de promesas con 75ms entre cada una
(~13 req/s) para respetar la cuota. Consecuencia: `analyzeMatch` hace muchas llamadas
encadenadas → es **inherentemente lento** (segundos), por diseño. No es un bug, pero es la
razón por la que "analizar un partido" nunca será instantáneo. Optimizable solo subiendo
plan de cuota o pre-calentando caché (lo que ya hacen los crons nocturnos).

## LATENCIA AÑADIDA POR CÓDIGO (resumen de lo optimizable)
1. **Doble/triple polling en vivo** (A3) — eliminar poll HTTP cuando el WS está conectado.
2. **2× RTT en SELECT+count** (M1) — un solo query con `count(*) OVER()`.
3. **Write a BD por page-load** (M6) — throttle de `last_seen`.
4. **Fetches en serie en refresh-live** (M8) — `Promise.all` con límite.
5. **SSL sobre internet pública a Postgres** (`db.js:50`) — si web y BD están en el mismo
   VPS, usar socket Unix / `localhost` sin SSL elimina handshake por conexión. **Verificar
   topología**: si `DATABASE_URL` apunta a `127.0.0.1`/socket, ya está bien; si apunta a
   IP pública, cada conexión nueva paga TLS.
6. **`images.unoptimized:true`** (`next.config.mjs:10`) — sin optimización de `next/image`,
   se sirven imágenes a tamaño completo → más bytes, más lento en móvil. Contradice
   CLAUDE.md §7. (Posible decisión consciente por correr sin el optimizador de Vercel;
   alternativa: `sharp` loader propio, que ya está instalado.)

---

## SUBSISTEMA: RUTAS API (backend)

### R1 — `/api/fixtures/route.js` (607 líneas): mayor acumulación de parches
**Archivo:** `app/api/fixtures/route.js`. Es la ruta más caliente (cada carga del dashboard).
Está bien paralelizada (varios `Promise.all` por fases), pero:
- **Normalización de estado de partido duplicada en 4+ sitios** con umbrales distintos
  (110min L1 Redis, 130min post-fetch, 150min comentado, 5min NS) — `:55,:69,:82,:310`.
  Lógica frágil y difícil de razonar; un cambio en un umbral no se propaga a los otros.
  Debería extraerse a UNA función `normalizeFixtureStatus(fixture, now)`.
- **N Redis GET sueltos para stats** (`:264,:327`) dentro de `Promise.all` — funciona, pero
  son N comandos; un `MGET`/pipeline explícito reduce el ida-y-vuelta a uno.
- Depende del footgun M5: importa `createSupabaseServerClient` de `supabase-auth` **y**
  `supabaseAdmin` de `supabase`. Aquí está bien, pero es el patrón que puede romperse.
- Complejidad ciclomática altísima en un solo handler → superficie de bugs. Candidata #1
  a refactor por fases (extraer carga de fixtures, normalización de estado, merge de
  análisis/odds a módulos en `lib/`).

### R2 — `/api/live-poll`: devuelve TODOS los lives del día sin filtrar
**Archivo:** `app/api/live-poll/route.js:25-34`. Sin `fixtureId`, devuelve `Object.values`
de todos los partidos en vivo del día en cada poll (cada 15s por cliente que tenga el
dashboard abierto). Payload potencialmente grande × muchos clientes × cada 15s. El WS ya
empuja estos datos → el poll es redundante (ver A3). Si se conserva como fallback, debería
soportar filtrado por los fixtures visibles.

### R3 — 🔴 CRÍTICO: webhook de Stripe acepta eventos SIN firma → activación gratis de planes
**Archivo:** `app/api/webhook/route.js:71-80`.
```js
if (webhookSecret && sig) {
  event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
} else {
  event = JSON.parse(body);   // ← acepta CUALQUIER JSON sin verificar
}
```
Si `STRIPE_WEBHOOK_SECRET` falta o está mal configurado, **cualquiera** puede hacer POST a
`/api/webhook` con `{type:'payment_intent.succeeded', data:{object:{metadata:{userId,plan},
customer}}}` y activarse un plan de pago gratis (`activateUser` pone `subscription_status:
'active'`). El middleware además **excluye `/api/webhook` del rate limit** (`middleware.js:138`),
así que se puede automatizar. CLAUDE.md §3 exige "webhooks verificados con firma".
**Fix:** si no hay `webhookSecret` o `sig` → responder 400 y NO procesar. Nunca `JSON.parse`
como fallback.

### R4 — 🟠 ALTO: webhook sin idempotencia → suscripciones y emails duplicados
**Archivo:** `app/api/webhook/route.js:82-104`. Stripe reintenta entregas (y reentrega ante
el 500 que devuelve el handler en error, `:143`). No hay dedup por `event.id`. Cada reintento
de `payment_intent.succeeded` vuelve a ejecutar `activateUser` (email duplicado) y
`createPostPaymentSubscription` (posible **suscripción Stripe duplicada** → doble cobro).
**Fix:** tabla `stripe_events(id PK, processed_at)`; al entrar, `INSERT ... ON CONFLICT DO
NOTHING` y si ya existía, responder 200 sin reprocesar.

### R5 — `stripe.js`: `getOrCreateProduct` lista hasta 100 productos en cada alta de suscripción
**Archivo:** `lib/stripe.js:98-104,179`. En cada `createPostPaymentSubscription` hace
`products.list({limit:100})` + `find by name`. Llamada extra a Stripe + frágil ante
colisión de nombres. **Fix:** cachear los `product_id` por plan (env o tabla `app_config`).

### R6 — `/api/chat`: validación e idempotencia débiles + broadcasts en serie
**Archivo:** `app/api/chat/route.js:59-94`.
- Sin validación de **longitud** del mensaje (solo `.trim()` no vacío) → un cliente puede
  enviar un mensaje enorme que se guarda y se difunde a todos. Falta Zod (CLAUDE.md §2.6).
- Los dos `await triggerEvent(...)` (`:87,:90`) son **secuenciales** y bloquean la respuesta;
  cada uno es un POST HTTP al worker. Para acelerar el envío, hacerlos fire-and-forget o
  `Promise.all`.
- `triggerEvent` se importa de `lib/pusher` (shim) → `realtime.js` → POST a `worker/broadcast`.
  Cada mensaje de chat = round-trip extra web→worker antes de llegar al WS.

### R7 — `/api/checkout`: el cliente elige la moneda de cobro; sin Zod
**Archivo:** `app/api/checkout/route.js:11,35` → `lib/stripe.js:121,132`. La `currency` viene
del body del cliente y determina la moneda/monto del PaymentIntent (vía `convertAmount`).
El monto se recalcula server-side por FX (mitiga fraude), pero conviene validar `currency`
contra una allowlist y usar Zod en el body. Riesgo bajo, pero es entrada de usuario sin esquema.

### R8 — 🟠 ALTO: `/api/match/[id]` SIN autenticación (contenido premium + quema de cuota)
**Archivo:** `app/api/match/[id]/route.js` (GET y POST, sin `getUser()`/sesión). El
`middleware.js` tampoco protege `/api/match`. Consecuencias:
- **GET** devuelve el análisis completo (contenido de pago) a cualquiera sin sesión.
- **POST** con `action: 'analyze' | 'refresh-stats' | 'refresh-lineups'` ejecuta
  `analyzeMatch`/`fetchMatchStats`/`refreshLineups` → **gasta cuota de API-Football** sin
  autenticación ni rate-limit específico (solo el `apiGen` 60/min/IP).
- GET con caché ausente dispara `analyzeMatch` **inline** (`:29`), que con el throttle de
  75ms tarda segundos (`maxDuration=300`). Un atacante puede forzar análisis caros en bucle.
**Fix:** exigir sesión + plan activo en este route; mover las acciones que gastan cuota a
un bucket de rate-limit estricto.

### R9 — `/api/refresh-live`: público + Pass 1/Pass 2 con fetches en SERIE
**Archivo:** `app/api/refresh-live/route.js`.
- POST **sin auth** (bounded por lock Redis 15s/5s, pero igual quema cuota anónimamente).
- **Pass 1** (`:212-232`) y **Pass 2** (`:249-289`) hacen `await apiFetchFixture(...)` dentro
  de bucles `for` → N fetches secuenciales (latencia N×RTT). Solo `needsStatsFetch` (`:161`)
  y el bloque viewDate (`:334`) usan `Promise.all`. **Fix:** `Promise.all` con límite de
  concurrencia también en Pass 1/2.
- **`extractLiveStats` DUPLICADO y DIVERGENTE** del worker: aquí `getVal = stat?.value || 0`
  (`:26-29`) trata `null`/`"null"` como **0**; el worker (`jobs/futbol/live.js` `statLookup`)
  devuelve `null` para desconocido y maneja aliases ("Corner Kicks"/"Corners"/...). Hay dos
  parsers de stats con comportamiento distinto → datos inconsistentes según el camino que
  los genere. **Fix:** una sola función compartida en `lib/`.
- Repite los heurísticos 110/130min de force-finish (mismos que R1) → triplicado.

### R10 — `/api/live` y `/api/live-poll` son redundantes
**Archivos:** `app/api/live/route.js` y `app/api/live-poll/route.js`. Ambos leen
`KEYS.liveStats(date)` y devuelven `Object.values`. Dos endpoints casi idénticos para lo
mismo. Consolidar en uno.

### R11 — 🔴 CRÍTICO: la contraseña en texto plano se envía por email al registrarse
**Archivos:** `app/api/register/route.js:56` → `lib/zeptomail.js:94,107`.
`sendWelcomeEmail({ to, name, password })` incrusta `${password}` en claro en el HTML del
correo de bienvenida (`<span ...>${password}</span>`). Es decir: **cada registro envía la
contraseña del usuario por email**. El email es un canal inseguro (se almacena en buzones,
logs de servidores SMTP, copias). El comentario del register dice "NO incluir password en
claro... ya no es necesario", pero el código del template **sí la incluye**. Viola toda
buena práctica (y la propia regla de CLAUDE.md de no exponer secretos). **Fix:** quitar
`password` del template y de la firma de `sendWelcomeEmail`; nunca transmitir la contraseña
elegida por el usuario.

### R12 — 🟡 `/api/tournament-predict` sin auth ejecuta Monte Carlo hasta 50.000 iteraciones
**Archivo:** `app/api/tournament-predict/route.js:32,60,108`. Endpoint público que corre
`simulateBracket(..., iterations)` con `iterations` controlado por el cliente (cap 50k) y
`maxDuration=60`. CPU-bound sin autenticación → vector de DoS (saturar CPU del VPS con
llamadas concurrentes). **Fix:** exigir sesión, bajar el cap, cachear por
`league:season:iterations`.

### R13 — 🟡 `/api/baseball/match/[id]` y `/api/match/[id]` exponen análisis premium sin auth
Ya cubierto para fútbol en R8. `baseball/match/[id]` (`route.js:9`) es GET sin sesión que
devuelve `baseball_match_analysis` completo (contenido de pago).

### R14 — `/api/register`: doble escritura de perfil + sin Zod
**Archivo:** `app/api/register/route.js:42-51`. `signupUser` ya crea `user_profiles` minimal
(`auth-pg.js:99`), y el route lo vuelve a `upsert` con country/plan → dos writes para lo
mismo. Validación manual en vez de Zod (CLAUDE.md §2.6). `password.length<8` chequeado aquí
y en `signupUser` (duplicado).

### R15 — `/api/push/renew`: full-table scan de `push_subscriptions` por llamada
**Archivo:** `app/api/push/renew/route.js:44-54`. Lee TODAS las filas de
`push_subscriptions` y las escanea en JS para encontrar el `oldEndpoint`. El diseño
anti-abuso (endpoint como prueba de propiedad, Zod) es correcto, pero el escaneo es
O(usuarios) por renovación. **Fix (cuando escale):** índice/consulta sobre el endpoint (p.ej.
columna generada o búsqueda con `jsonb` operadores) en vez de traer toda la tabla.

### R16 — `/api/matches` redundante con `/api/fixtures`
**Archivo:** `app/api/matches/route.js`. `getFixtures(date)` + quota, sin auth; versión
reducida de `/api/fixtures`. Otro endpoint duplicado (puede tocar API-Football para fechas
futuras → quema cuota anónima). Consolidar o eliminar si el frontend no lo usa.

### Mapa de auth por ruta (escaneo sistemático)
Rutas SIN ningún check de sesión/secreto (algunas legítimas, otras no):
- **Legítimas públicas:** `auth/*` (login/logout/forgot/reset), `register`, `currency`,
  `detect-country`, `quota`, `baseball/quota`, `baseball/leagues`, `baseball/standings`,
  `odds`, `live`, `live-poll`, `pick-image` (OG image), `combinada-dia` (si es público a
  propósito).
- **Problemáticas (premium/cómputo/cuota sin auth):** `match/[id]` (R8), `refresh-live`
  (R9), `tournament-predict` (R12), `baseball/match/[id]` (R13), `matches` (R16).
- **Dead set duplicado:** `auth-pg/*` (login/signup/me/verify/forgot/reset) — duplica
  `auth/*` (M4). Confirmar que el frontend no lo usa y borrar.

### R17 — 🟠 ALTO: bypass de auth de cron vía header `x-internal-trigger` (forjable)
**Archivos:** honran ese header: `cron/live`, `cron/analyze-batch`, `cron/finalize`,
`admin/reanalyze` (+ lo emite `fixtures/route.js:418`). El header lo puede poner **cualquier
cliente** → salta el `CRON_SECRET`. Impacto: encolar `futbol-live`, `analyze-batch`,
`finalize` y disparar **reanalyze admin** sin credenciales → quema de cuota API-Football +
cómputo. **Fix:** eliminar el bypass por header; para triggers internos usar el `CRON_SECRET`
real en la cabecera `Authorization`.

### R18 — 🟡 Todas las rutas cron abren del todo si `NODE_ENV !== 'production'`
**Archivos:** 15 de 16 `cron/*` tienen `|| process.env.NODE_ENV !== 'production'` en
`verifyAuth`. Si en el VPS `NODE_ENV` no está fijado a `'production'` (pm2/tsx puede dejarlo
sin definir), **todas las rutas cron quedan abiertas** (cualquiera encola jobs). **Fix:**
verificar que `NODE_ENV=production` está garantizado en el entorno del worker/web; no confiar
en esa rama para seguridad.

### R19 — 🟡 La "red de seguridad" fixtures→cron/daily está MUERTA en producción
**Archivos:** `fixtures/route.js:417` hace `fetch('/api/cron/daily', {headers:{x-internal-trigger}})`
**sin** `CRON_SECRET`, pero `cron/daily/route.js:10-15` NO honra `x-internal-trigger` (solo
secret o NODE_ENV). En prod → 401 → el re-disparo automático del análisis del día **nunca
ocurre**. El comentario "Red de seguridad" describe algo que no funciona. (Mitigado porque
el scheduler real vive en el worker `schedulers.ts`, pero el backup HTTP es inútil.)

### R20 — 🟡 `/api/admin/setup-db`: SQL de migración OBSOLETO apuntando a Supabase muerto
**Archivo:** `app/api/admin/setup-db/route.js`. El `MIGRATION_SQL` usa `auth.users(id)`,
`auth.uid()`, políticas RLS y `service_role` — **todo específico de Supabase**, y hace POST
a `https://api.supabase.com/v1/projects/fdgxpznafsmhnuxjmcgd/...` (project ref **hardcodeado**
del Supabase ya abandonado). Tras la migración a Postgres VPS, este endpoint crearía tablas
en la base **equivocada** (la muerta) y con FKs a `auth.users` que ya no existen en el VPS.
Código muerto y peligroso si se ejecuta. **Fix:** borrar el endpoint o reescribir el SQL
contra el esquema real del VPS (`public.users`, sin RLS de Supabase).

### R21 — `/api/cron/*` (16 rutas) duplican el scheduler real del worker
Los `cron/*` son "thin enqueuers" que hacen POST a `worker/enqueue/:queue`. Pero el
verdadero scheduling vive en `apps/cfanalisis-worker/src/schedulers.ts`
(`upsertJobScheduler`). Las rutas HTTP son un segundo camino redundante (legacy de la época
Vercel/cron-job.org). Si nadie las llama ya, son superficie de ataque innecesaria → evaluar
borrado.

### Notas menores de esta ola
- `/api/user`: `hide`/`unhide` hacen upsert/delete **+ re-SELECT completo + recache** (2
  queries por acción) e invalidan con `redisSet(key,null,1)` antes de re-setear (patrón raro
  pero funcional). `save-combinada` sin Zod.
- `/api/push/subscribe`: correcto y auth'd (bug previo de "success aunque falle" ya
  arreglado, `:42-52`). `/api/combinada-dia`: correcto (uso n8n).
- **Project ref Supabase hardcodeado** `fdgxpznafsmhnuxjmcgd` en `setup-db` (y en MEMORY.md) —
  referencia muerta.

### R22 — 🟠 ALTO: `/api/analisis` valida sesión pero NO la exige → análisis masivo sin auth
**Archivo:** `app/api/analisis/route.js:11-12`. Hace `const { data: { user } } = await
supabase.auth.getUser(); const userId = user?.id || null;` y **nunca comprueba** `if (!user)`.
Luego acepta un array `fixtures` arbitrario del body y ejecuta `analyzeMatch` sobre 5 de
ellos (`:21-35`), gastando cuota de API-Football + cómputo. Sin auth efectiva y solo bajo el
rate-limit genérico (60/min/IP) → hasta ~300 `analyzeMatch`/min anónimos = destrucción de
cuota. (Mi escaneo lo marcó "AUTH" porque importa el cliente, pero el resultado no se
aplica — falso positivo.) **Fix:** `if (!userId) return 401`.

### R23 — `/api/admin/reanalyze`: OWNER_EMAIL hardcodeado + bypass interno
**Archivo:** `app/api/admin/reanalyze/route.js:18,80`. `OWNER_EMAIL='ferneyolicas@gmail.com'`
hardcodeado. El POST con `x-internal-trigger` salta la sesión (R17) y permite manejar el
batch de reanálisis (quema cuota). **Fix:** owner por env var; quitar el bypass de header.

### R24 — `/api/admin/clients` GET: N llamadas a Stripe por carga (admin)
**Archivo:** `app/api/admin/clients/route.js:34-74`. Por cada usuario activo con
`stripe_customer_id` hace `subscriptions.list` (+ a veces `charges.list`) en `Promise.all`.
Con muchos clientes activos son decenas de llamadas a Stripe por carga del panel (lento +
posible rate-limit de Stripe). **Fix:** cachear `next_payment_at` (escribirlo desde el
webhook `customer.subscription.updated`) en vez de consultarlo en vivo. *(El resto del
endpoint —`requireAdmin`, Zod, audit log, cancelación de subs en revoke— está bien hecho.)*

### R25 — 🟡 `/api/pick-image`: SSRF + CPU sin auth ni caché
**Archivo:** `app/api/pick-image/route.js:35-46,80-121`. Endpoint **público** que:
- Hace `fetch(url)` sobre URLs arbitrarias del cliente (`homeLogo`/`awayLogo`/`leagueLogo`)
  → **SSRF**: se puede apuntar a servicios internos del VPS o endpoints de metadata. **Fix:**
  allowlist de host (`media.api-sports.io`) antes de hacer fetch.
- Renderiza con `satori` + codifica PNG con `sharp` (CPU pesado) en **cada** request, sin
  caché (`no-store`) ni auth → vector de DoS. **Fix:** cachear por hash de query; rate-limit.

### R26 — 🟡 `/api/tickets`: ticket_id por COUNT → race condition + full scan
**Archivo:** `app/api/tickets/route.js:68-69`. `ticketId = 'CFA_' + (1000 + count)` usando
`count(*)` de la tabla. Dos creaciones simultáneas obtienen el mismo `count` → mismo
`ticket_id` → choca con el UNIQUE (uno falla). Además `count(*)` escanea toda la tabla por
ticket. **Fix:** secuencia/serial en DB o sufijo aleatorio.

### R27 — `/api/baseball/analisis`: bucle de juegos en SERIE (auth correcta)
**Archivo:** `app/api/baseball/match/.../analisis/route.js:118`. El `for...of fixtures` analiza
cada juego secuencialmente (el trabajo intra-juego sí es `Promise.all`). Con muchos juegos
es lento (`maxDuration=300`). Auth bien hecha (sesión + suscripción activa). *(Nota: bien
estructurado; solo el bucle exterior es secuencial.)*

### Rutas restantes (escaneo) — sin hallazgos graves
- `/api/combinada-alta`: CRON_SECRET ok (n8n). `/api/favorites`, `/api/hidden`, `/api/hide`,
  `/api/user/*` (role/timezone/leagues): auth'd, CRUD simple sobre PG.
- `/api/currency`, `/api/detect-country`, `/api/quota`, `/api/baseball/quota`,
  `/api/baseball/leagues`, `/api/baseball/standings`: lectura pública de bajo riesgo.
- `/api/auth/check-access`, `/api/auth/session`, `/api/auth/supabase/session`: lectura de
  sesión (la última es legacy Supabase → candidata a borrar).
- `/api/push/test`: auth'd. `/api/admin/*` (ferney/audit-logs/vps-stats): `requireAdmin`.

*(SUBSISTEMA RUTAS API: completado. Siguen frontend, worker jobs, modelo y scripts.)*

---

## SUBSISTEMA: FRONTEND

### F1 — 🟡 [CORREGIDO] El detalle SÍ recibe el marcador por WS (vía contexto); el poll de 15s es redundante
> ⚠️ **CORRECCIÓN DE FIDELIDAD:** el párrafo de abajo (mi primera versión) está **MAL**.
> Tras leer `analisis/[id]/page.js:197-205`: la página lee `allLiveStats[fixtureId]` del
> contexto `live-stats-context.js`, que **sí** está suscrito a Pusher (`usePusherEvent
> ('live-scores','update')` + `'corners-update'`). O sea, **el marcador/estado en vivo llegan
> por WebSocket** (a ~ms del tick de 20s), NO en 15-35s. Lo real: la página corre **además**
> un `pollLiveStats` cada 15s (`:184,:193`) + dispara `/api/refresh-live` (`:147`) → eso es
> **redundancia** (como F2), no ausencia de realtime. Fix: reemplazar el poll de 15s por la
> suscripción WS por-fixture y dejar el poll solo como fallback. (Dejo el texto original
> debajo, tachado conceptualmente, como registro del error y su corrección.)

~~### F1(original, ERRÓNEO) — El detalle de partido en vivo NO usa WebSocket (solo polling 15s)~~
**Archivo:** `app/dashboard/analisis/[id]/page.js`. La página donde el usuario **observa un
partido concreto** NO llama `usePusherEvent`/`useWorkerEvent` (confirmado: no aparece en el
archivo). Solo hace `setInterval(pollLiveStats, 15000)` (`:193`) contra `/api/live-poll` y
dispara `/api/refresh-live` desde el cliente (`:147`). Resultado: un gol tarda **hasta 15s
(poll) + hasta 20s (cron) ≈ 35s** en aparecer. **Este es el mayor cuello para tu objetivo de
"tiempo real":** suscribir esta página al WS (`live-scores`/`match-updates`) haría que el gol
aparezca a los ~ms de detectarlo el cron (piso real = los 20s del cron). Es el cambio de
mayor impacto/€.

### F2 — 🟠 El dashboard solapa WebSocket + 3 polls + reloj 1s
**Archivo:** `app/dashboard/page.js`. Corre **a la vez**: WS (`usePusherEvent` live-scores,
match-updates, odds-update, batch-complete, `:624-660`), `setInterval(refreshLiveData,
30000)` (`:495`, llama `/api/refresh-live` que quema cuota), SWR `refreshInterval:60_000`
(`:223`), `pollBatch` (`:670`) y `setInterval(tick,1000)` (`:2885`). Con el WS ya activo, los
polls de 30s/60s son redundantes. **Fix:** WS como única fuente en vivo; activar
`refreshLiveData`/SWR **solo** como fallback cuando `useWorkerSocketState() !== 'connected'`.

### F3 — 🟡 Reloj `setInterval(1000)` re-renderiza componentes gigantes cada segundo
**Archivos:** `dashboard/page.js:2885`, `analisis/[id]/page.js:79`. Un tick de 1s en el
componente raíz fuerza re-render de un árbol de 2.000–2.900 líneas cada segundo. **Fix:**
aislar el reloj en un subcomponente diminuto (o `useRef` + actualización del DOM) para no
re-renderizar toda la página por el contador de minuto de partido.

### F4 — 🟡 `refreshFinishedStats` dispara N POST `/api/match/[id]` (sin auth, quema cuota)
**Archivo:** `dashboard/page.js:261-278`. Al cargar, por cada partido FINALIZADO sin stats
hace `Promise.allSettled` de N `fetch POST /api/match/{id} {action:'refresh-stats'}`. Son
paralelos (bien), pero cada uno es la ruta sin auth de R8 que puede tocar API-Football.
Ligado a R8: además de proteger la ruta, conviene que el cron deje los stats listos para no
depender de este disparo desde el cliente.

### F5 — 🟡 `providers.js`: el shim `supabase` se recrea en cada render
**Archivo:** `components/providers.js` (objeto `const supabase = {...}` sin `useMemo`). Nueva
referencia por render → consumidores del contexto re-renderizan. **Fix:** `useMemo`.
*(Por lo demás el provider de auth está bien: cookie httpOnly, `/api/auth/session`.)*

---

## SUBSISTEMA: WORKER (BullMQ)

### W1 — 🟡 N+1 de favoritos en la ruta caliente de notificaciones en vivo
**Archivo:** `apps/cfanalisis-worker/src/jobs/futbol/live.js:716-745`. En cada tick (cada 20s)
`sendBundledPushes` lee todas las `push_subscriptions` y luego hace **una query
`user_favorites` por usuario** (`Promise.all` sobre N usuarios). A escala = N queries cada
20s. **Fix:** una sola query `SELECT user_id, fixture_id FROM user_favorites WHERE user_id
IN (...)` y agrupar en memoria.

### W2 — 🟡 Logging muy verboso en la ruta caliente de live
**Archivo:** `jobs/futbol/live.js` (decenas de `console.log` por fixture/evento por tick).
Útil para depurar córners/penaltis/VAR, pero a escala es spam de logs + I/O cada 20s. **Fix:**
bajar a nivel debug detrás de un flag (`LIVE_DEBUG`), dejando solo el resumen por tick.

### W3 — Calidad del worker (positivo)
`pool.ts` (`mapPool` de concurrencia acotada que satura el rate-limiter sin idle),
`workers.ts` (locks/stall por cola: LIGHT/HEAVY/MARATHON, alertas Telegram en `failed`/`error`),
`server.ts` (health checks, event-log). Bien diseñado. El push de `live.js` tiene semántica
**at-least-once** correcta (marca dedup solo tras entrega), urgencia `high` para iOS, y purga
de endpoints expirados. Es de lo mejor del repo.

### W3b — `finalize.js` bien hecho + es el 4º parser de stats (correcto)
**Archivo:** `apps/.../jobs/futbol/finalize.js`. Dos pasadas (Redis rápido → fallback Supabase
para Redis-expirados), `mapPool` concurrencia 10, distingue **FT (90') vs AET** para no
contaminar la calibración de over/under (las casas pagan a 90'). Su `getStat` (`:53-67`)
maneja `null`/`"null"` correctamente (como el de `live.js`). ⇒ confirma AF1: hay **4**
implementaciones de extracción de stats — 2 correctas (`finalize.getStat`, `live.statLookup`)
y 2 con bug `null→0` (`api-football.fetchMatchStats`, `refresh-live.getVal`). Unificar en una.

### W4 — Comentarios obsoletos en el worker
`workers.ts:88` menciona "Dixon-Coles" (PURGADO 2026-05-29 según memoria) y `:58-60`
menciona "Upstash" (eliminado). Documentación desfasada.

### W5 — 🟡 Divergencia de configuración Redis web vs worker
**Archivos:** `lib/redis.js` (web) usa `LOCAL_REDIS_HOST`/`LOCAL_REDIS_PORT` **sin password**,
`maxRetriesPerRequest:3`, `enableReadyCheck:true`. `apps/.../redis.ts` (worker) usa
`REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`, `maxRetriesPerRequest:null`,
`enableReadyCheck:false` (requisito BullMQ). Apuntan al mismo Redis local pero con **nombres
de env var distintos** y el cliente web **no lee password**. Si algún día se pone
`REDIS_PASSWORD` en el Redis local, la web dejaría de conectar silenciosamente. **Fix:**
unificar nombres de env y que ambos lean password.

---

## SUBSISTEMA: MODELO (lib) + SCRIPTS

### MO1 — 🔴 Contraseña de admin HARDCODEADA y commiteada
**Archivo:** `scripts/seed-admin.js:33,39`. `bcrypt.hash('Pump0517*', 12)` para
`ferneyolicas@gmail.com` (cuenta owner). La contraseña en claro `Pump0517*` está en el
repositorio (y en el historial de git). Aunque el script es legacy (referencia Sanity
`_type=='cfaUser'`), la credencial quedó expuesta. **Fix:** rotar YA la contraseña del admin;
quitar el literal del script (leer de env/prompt); idealmente purgar del historial git.

### MO2 — 🟡 [CORREGIDO] `supabase-cache.js` es CASI todo código muerto (no divergencia activa)
**Corrección de fidelidad:** verifiqué `apps/.../shared.ts:103-112`. El worker usa
**`sanity-cache.js`** para análisis/fixtures (`cacheAnalysis`, `getCachedAnalysis`,
`cacheFixtures`, `getCachedFixturesRaw`, `getAnalyzedFixtureIds`, `incrementApiCallCount`).
De `supabase-cache.js` SOLO se usan `saveMatchSchedule`/`getMatchSchedule`. Por tanto las
funciones de análisis/fixtures de `supabase-cache.js` (`getAnalysisCached`, `saveAnalysisCached`,
`getFixturesCached`, `getAnalyzedIdsForDate`, `getAppConfig`) son **código muerto** — NO hay
dos cachés activas divergiendo (mi versión anterior lo exageró). PERO ese código muerto **sí
tiene bugs latentes** si alguien lo reactivara: usa claves Redis distintas (`analysisData:X`
vs `analysis:fixture:X` de sanity-cache) y **no chequea `cache_version`**. **Fix:** borrar las
funciones muertas de `supabase-cache.js` y mover `saveMatchSchedule`/`getMatchSchedule` a un
`content-cache.js` único; renombrar `sanity-cache.js` (ya no toca Sanity). Es deuda de nombres/
organización, no un bug activo de inconsistencia.

### MO3 — Motor de contexto bien construido (positivo)
**Archivo:** `lib/context-engine.js:520-556`. Carga stats/events/halfstats/lineups/injuries
con `ref_id = ANY($::bigint[])` (una query por endpoint) + `Promise.all` — **no hay N+1**.
Lee de `raw_api_payloads` (pre-capturado por raw-backfill), arquitectura sólida. La
**corrección estadística** del modelo (probabilidades, calibración, combinada) NO se validó
matemáticamente en esta auditoría — es un trabajo especializado aparte (ver nota de alcance).

### MO4 — `lib/api-football.js` (2073 líneas) — el archivo más grande
Throttle global 75ms (M9), caché L1/L2, `analyzeMatch` orquesta muchas llamadas. Bien
estructurado para la cuota, pero es un monolito; candidato a dividir por responsabilidad
(fetch, caché, enriquecimiento, scoring). Sin bugs evidentes de latencia más allá de M9.

### MO5 — Scripts (≈6.160 líneas, ~40 archivos)
One-offs de backfill/migración/entrenamiento. **Sin secretos hardcodeados** salvo MO1.
Riesgo de producción bajo (ejecución manual). `send-promo-email.js` (envío masivo) y
`retry-failed-payments.js` (toca pagos) conviene ejecutarlos con cuidado/idempotencia.
`.env.local` NO está trackeado en git (correcto).

---

# RESUMEN EJECUTIVO Y ORDEN DE REMEDIACIÓN

## Veredicto sobre "1ms para todo"
**Imposible por física de redes** (RTT, TLS, render 16ms, API-Football 100-800ms). El piso
real de "tiempo real" en vivo = **20s** (cron `futbol-live-20s`). Lo alcanzable y valioso:
eliminar la latencia AÑADIDA por código. El cambio de mayor impacto para tu objetivo es **F1**
(suscribir el detalle de partido al WebSocket → goles en ~ms tras el tick, no en 15-35s).

## Índice de hallazgos por severidad
**🔴 CRÍTICOS (5):**
- C1 — `WORKER_SECRET` filtrado al navegador (control total del worker).
- R3 — Webhook Stripe acepta eventos sin firma → activación gratis de planes.
- R11 — Contraseña en texto plano enviada por email al registrarse.
- MO1 — Contraseña de admin hardcodeada en `scripts/seed-admin.js`.
- (R4 — Webhook sin idempotencia → suscripciones/cobros duplicados — crítico de negocio.)

**🟠 ALTOS (8):** A1 headers seguridad ausentes · A2 rate-limit no compartido · A3/F1/F2
realtime solapado + detalle sin WS · R8 `/api/match/[id]` sin auth (premium+cuota) · R17
bypass `x-internal-trigger` · R22 `/api/analisis` sin auth efectiva.

**🟡 MEDIOS (~20):** M1 SELECT+count 2 RTT · M5 colisión `createSupabaseServerClient` · M6
write a BD por page-load · R5 Stripe product lookup · R9 refresh-live serie + parser divergente
· R12 tournament-predict DoS · R20 setup-db SQL muerto · R25 pick-image SSRF · R26 tickets
race · W1 N+1 favoritos en live · W5 divergencia Redis · MO2 doble caché.

**Deuda/parches:** shims pusher no-op, `sanity-cache`/`supabase-cache` mal nombrados, auth
duplicada (`auth` vs `auth-pg`), normalización de estado de partido repetida en 4+ sitios,
crons HTTP redundantes con el scheduler del worker, comentarios obsoletos (Dixon-Coles/Upstash).

## Orden de remediación sugerido (cuando decidas arreglar)
1. **Hoy (riesgo activo):** R3 (firma webhook obligatoria) · R11 (quitar password del email)
   · MO1 (rotar admin) · C1 (separar secreto WS del admin).
2. **Esta semana:** R4 idempotencia Stripe · R8/R22 auth en rutas de cuota · R17 quitar
   bypass header · A1 headers seguridad · A2 rate-limit a Redis.
3. **Rendimiento "tiempo real":** F1 (detalle→WS) · F2 (WS primario, polls solo fallback) ·
   F3 (aislar reloj 1s) · M1 · W1.
4. **Limpieza de deuda:** borrar auth-pg/*, shims pusher, supabase-cache, crons HTTP muertos,
   setup-db; unificar normalización de estado y caché; renombrar módulos engañosos.

## Nota de alcance
Cubierto línea por línea / con escaneo dirigido: infraestructura (db/redis/ratelimit),
realtime/WS (cliente+worker), middleware/config, auth completa, **las 75 rutas API**, capa de
datos del frontend (efectos/fetch/WS de las 4 páginas grandes), worker (infra + job live + jobs)
y scripts. La **validación matemática del modelo de predicción** (calibración, probabilidades,
EV de combinadas) NO entra aquí: es correctitud estadística de dominio, auditoría separada.

---

---

## SUBSISTEMA: `lib/api-football.js` (2073 líneas, leído completo)

### AF1 — 🟡 TRES parsers de stats divergentes (fuente de datos inconsistentes)
Existen tres implementaciones distintas de "extraer corners/cards de un fixture":
1. `lib/api-football.js:2027` (`fetchMatchStats`, `getVal = stat?.value || 0`),
2. `app/api/refresh-live/route.js:26` (igual, `|| 0`),
3. `apps/.../jobs/futbol/live.js` (`statLookup`, devuelve `null` para desconocido + aliases
   "Corner Kicks"/"Corners"/...).
Las dos primeras tratan `null`/`"null"` como **0** (reportan "0 corners" cuando en realidad
es "desconocido") y NO manejan aliases de nombre de stat por liga. La tercera sí. Resultado:
los mismos stats salen distintos según qué código los genere. **Fix:** una sola función
`extractFixtureStats` compartida en `lib/`.

### AF2 — Monolito de 2073 líneas (mantenibilidad)
Mezcla: rate-limiter, fetch/caché, fixtures, `analyzeMatch` (orquestación), extracción de
stats, player highlights, extracción/merge de odds, standings. Viola responsabilidad única.
Candidato a dividir en `rate-limiter.js`, `fixtures.js`, `analyze.js`, `odds-extract.js`.

### AF3 — Comentarios obsoletos y logging verboso
- "ONLY the 8 authorized bookmakers" (`:1617,:1923`) pero `ALLOWED_BOOKMAKERS` tiene **2**
  (bet365, bwin). Comentario desfasado.
- Decenas de `console.log('[ANALYSIS]'…/'[ENRICH-L5]'…)` por cada análisis → spam de logs en
  el batch diario (100+ partidos). Bajar a debug tras flag.
- Stubs muertos `getHiddenMatches`/`hideMatch`/`unhideMatch` (`:2071-2073`) devuelven `[]`.

### AF4 — `analyzeMatch` pasos 6/7/8 secuenciales (menor)
Injuries→lineups→odds (`:522-551`) son `await` en serie; el throttle global ya serializa el
fetch real, así que el impacto es pequeño, pero podrían ir en `Promise.all`. El resto de
`analyzeMatch` está bien paralelizado (`:583` bloque de stats/players/events). Sin bugs de
correctitud evidentes; el throttle 75ms (M9) es la latencia inherente.

---

## SUBSISTEMA: FRONTEND — `app/dashboard/page.js` (2900 líneas, leído por tramos)

### F6 — 🟡 CINCO escritores concurrentes del mismo estado `fixtures`/`liveStats`
**Archivo:** `dashboard/page.js`. Escriben sobre el mismo estado: (1) SWR `onSuccess` (`:231`),
(2) `refreshLiveData`/`mergeLiveStats` (`:418-457`), (3) Pusher `live-scores` (`:627`),
(4) `loadFixtures`, (5) `refreshFinishedStats` (`:302`). De ahí la abundante lógica defensiva
"NEVER downgrade / never go backwards" (`:117-128`, `:424-444`) — es el síntoma de múltiples
escritores no coordinados. Funciona, pero es frágil y propenso a parpadeos/condiciones de
carrera. **Fix:** un solo reducer que centralice el merge (estado en vivo) con reglas de
prioridad explícitas en un único lugar.

### F7 — Comentario "exclusively Pusher / no polling" es FALSO
**Archivo:** `dashboard/page.js:676-677` dice "Live updates come exclusively from Pusher… No
more client-side polling". Pero coexisten: SWR `refreshInterval:60_000` **incondicional**
(`:223`) y `setInterval(refreshLiveData,30000)` (`:495`, este sí gated en `hasLive`). Además
el `useEffect` de montaje (`:478-487`) dispara `/api/refresh-live` en **cada apertura** del
dashboard. Es decir: el cliente dispara el cron de cuota. (Refuerza F2; el lock de 15s en
refresh-live acota el total global, pero la arquitectura "el cliente maneja el cron" persiste.)

### F8 — Owner hardcodeado en el cliente
**Archivo:** `dashboard/page.js:143` `isOwner = user?.email === 'ferneyolicas@gmail.com'`.
Email del owner hardcodeado en el bundle del cliente (cosmético: solo muestra el botón
re-analyze; el endpoint valida server-side). Aun así, mover a un claim de rol.

*(Tramos 760-2900: JSX de tarjetas/modales/combinada + `useMemo apuestaDelDia` + reloj 1s
(F3). La lógica de datos/realtime/efectos —donde viven los bugs— está cubierta arriba;
continúo con detalle, baseball y ferney.)*

### F1b — La página de baseball tiene el MEJOR patrón realtime (positivo, leído completo el data-layer)
**Archivo:** `app/dashboard/baseball/page.js:122-170`. Combina SWR 60s (periódico) +
`usePusherEvent('baseball-live','update')` que aplica `liveOverrides` instantáneos sobre los
games del SWR. Es el patrón correcto: WS para lo instantáneo, SWR como red de seguridad, un
único punto de merge (`liveOverrides`). El dashboard de fútbol (F2/F6/F7) debería converger a
esto. `analyzeSelected` (`:196-227`) está auth'd vía la ruta y hace `fixturesMutate()` +
`globalMutate(quota)`. Sin hallazgos negativos en su capa de datos.

### F9 — Detalle: acciones `/api/match/[id]` (refresh-lineups/injuries/analyze) sin coste extra de auth
**Archivo:** `analisis/[id]/page.js:209-241,281`. Los botones disparan POST a `/api/match/[id]`
con `action:'refresh-lineups'|'refresh-injuries'|'analyze'` — la ruta R8 (sin auth) que quema
cuota. Ligado a R8: al proteger esa ruta, recordar que estos botones del cliente la usan.

---

## SUBSISTEMA: MODELO — `lib/combinada.js` (660 líneas, leído completo)

### CB1 — 🟠 `combinedProbability` es el PROMEDIO de las selecciones, no el producto (engaña al apostador)
**Archivo:** `lib/combinada.js:646-647`.
```js
const combinedOdd         = selected.reduce((acc, m) => acc * m.odd, 1);          // PRODUCTO ✓
const combinedProbability = selected.reduce((a, m) => a + m.probability, 0) / selected.length; // PROMEDIO ✗
```
La cuota combinada es el **producto** (correcto para una combinada), pero la "probabilidad
combinada" es el **promedio** de las probabilidades individuales. Para una combinada, la
probabilidad de que **todas** acierten es el **producto** (asumiendo independencia), no el
promedio. Ejemplo: 5 selecciones al 80% → muestra 80%, cuando la probabilidad real de acertar
las 5 ≈ 0.8⁵ = **33%**. Es internamente inconsistente (cuota=producto, prob=promedio) y
**sobrestima gravemente** el riesgo real de la combinada que ve el usuario para apostar.
Además **diverge** de `/api/combinada-alta` que sí usa producto (`route.js:102`). **Fix:**
usar producto para `combinedProbability` (o etiquetar claramente "confianza media por
selección" si el promedio es intencional, pero entonces no llamarlo "probabilidad combinada").

### CB1-bis — CB1 está en los TRES builders de combinada (es la ruta principal)
**Archivos:** además de `combinada.js:647` (manual fútbol) y `baseball-model.js:683`, el
builder **principal** de fútbol `lib/context-probabilities.js:356` (`buildContextCombinada`,
el que usa `analyzeMatch`) **también** hace `combinedProbability = reduce(+prob)/length`
(promedio) con `combinedOdd` = producto (`:355`). Confirma que el problema CB1 es **sistémico
y está en producción** en la combinada que ve el usuario. El resto de
`context-probabilities.js` es sólido: regla inviolable (solo recomienda si bet365/bwin cotiza
≥1.20), equivalencia de línea entera (Over X = Over X.5), atribución de bookmaker por player.

### CB2 — Estructura (positivo)
`iterOuLines` (abstrae over/under con líneas dinámicas), `selectBestPlayerLine` (elige línea
del jugador maximizando EV = freq·(odd-1) con freq≥70%), dedup por categoría con desempate por
dificultad. Bien diseñado. Es una sola función de ~480 líneas (mantenibilidad), pero coherente.

---

## SUBSISTEMA: MODELO — `lib/baseball-model.js` (891 líneas, leído completo)

### BM1 — 🟠 CB1 también aplica a baseball (combinedProbability = promedio)
**Archivo:** `lib/baseball-model.js:683` y `:689`. `buildBaseballCombinada` computa
`combinedProbability = reportSet.reduce((acc,m)=>acc+m.probability,0)/reportSet.length`
(promedio), igual que fútbol (CB1). Mientras `combinedOdd` es el producto (`:682`). Mismo
problema de sobre-estimación del acierto de la combinada → confirma que CB1 es **sistémico**
(fútbol + baseball). Mismo fix.

### BM2 — 🟡 Modelo Poisson para carreras (overdispersión) parcheado con shrinkage
**Archivo:** `lib/baseball-model.js:45-73,272-274`. Usa Poisson para distribuir carreras, pero
el propio comentario reconoce que el béisbol es **Negative Binomial** (sobredisperso). El
parche `MONEYLINE_REG=0.78` (encoge hacia 0.5) compensa la sobreconfianza del Poisson. Es una
simplificación conocida (coincide con `baseball_calibration_modelo.md` de la memoria: "el
modelo no discrimina, 95% en 45-55%"). No es bug, es límite de modelado — para mejorar la
discriminación habría que pasar a Neg-Binomial o meter más señal (pitcher/park/lineup).

### BM3 — Firma de función con argumento ignorado
**Archivo:** `lib/baseball-model.js:402` llama `buildBaseballPlayerProbabilities(playerHighlights,
marketOdds)` pero la función (`:823`) declara **un solo** parámetro → `marketOdds` se descarta
silenciosamente. Inocuo, pero es código confuso/muerto. *(Por lo demás el modelo está bien
estructurado: de-vig + blend 60/40 con mercado, líneas adaptativas, EV en player props.)*

---

## SUBSISTEMA: `lib/odds-api.js` (611 líneas, leído completo) — The Odds API

### OA1 — 🟠 El contador de cuota cuenta 1 por llamada, pero The Odds API cobra markets×regions
**Archivo:** `lib/odds-api.js:142` (`bumpDailyReqCount(1)`), `:355-358` y `:574-577`.
The Odds API factura su endpoint `/odds` como **1 crédito por (región × mercado)**, no 1 por
llamada. Pero el código cuenta `+1` por llamada y el cap `DAILY_REQUEST_CAP=15` asume "1=1".
Llamadas reales:
- Fútbol: `markets='h2h,totals'` (2) × `regions='eu,uk,us,au'` (4) = **8 créditos** por sport
  key, contados como 1.
- Baseball: `markets='h2h,totals,spreads'` (3) × `regions='us,eu,uk'` (3) = **9 créditos**,
  contados como 1.
Con 15 "llamadas"/día el consumo real puede ser ~8-9× → muy por encima de los 500/mes del
plan free (el comentario "15/día = 450/mes" no se cumple). Riesgo: agotar/exceder la cuota y
quedarse sin cuotas. **Fix:** (a) contar `markets×regions` por llamada, o (b) **mejor**: gatear
con el header autoritativo `x-requests-remaining` (que ya se lee en `:150` pero no se usa para
el cap), y reducir regiones a las que de verdad aportan bet365/bwin (`eu,uk`). *(Verificar el
modelo de precios exacto contra tu plan — me baso en la regla región×mercado de The Odds API.)*

### OA2 — 🟡 Contador de cuota no atómico (read-modify-write)
**Archivo:** `lib/odds-api.js:21-27`. `bumpDailyReqCount` hace `redisGet` + `redisSet(cur+n)`
(no atómico) y el guard `usedToday >= CAP` (`:125-129`) es TOCTOU. Bajo concurrencia (job de
odds + baseball-analyze a la vez) el conteo se pierde/subestima. **Fix:** usar `redisIncr`
(ya existe en `lib/redis.js`, atómico) para el contador y el gate.

### OA3 — Comentario "8 authorized bookmakers" obsoleto (`:237`); en realidad 2 (bet365, bwin).
El resto (de-vig, matching fuzzy por nombre normalizado, caché 3h MLB, agregación de mejor
cuota) está bien.

### OA4 — 🟠 El "presupuesto" de `odds.js` NO mitiga OA1 (se cuenta en llamadas, no en créditos)
**Archivo:** `apps/.../jobs/futbol/odds.js:24` (`ODDS_BUDGET=2` ejecuciones/día) + `odds-api.js`
(`regions:'eu,uk,us,au'`=4 × `markets:'h2h,totals'`=2). Cada `fetchOddsForSport` = **8 créditos**
de The Odds API, pero se cuenta como 1. Con 2 ejecuciones × N ligas con partidos (~10) × 8 =
~160 créditos/día ≈ **4.800/mes** solo de fútbol → el plan free (500/mes) se agota en ~3-4 días.
Confirma y agrava OA1: los topes están en "llamadas", no en "créditos (región×mercado)". **Fix:**
reducir regiones a `eu,uk` (bet365/bwin son europeas) → 2×2=4 créditos, y/o gatear con el header
`x-requests-remaining`. (Si están en plan de pago, igual conviene; si no, ya deben estar
quedándose sin cuota a mitad de mes y tirando de caché.)

---

## SUBSISTEMA: jobs live restantes

### LC1 — 🟠 `live-corners.js` puede HACER RETROCEDER el contador de córners (bug que `live.js` sí arregló)
**Archivo:** `apps/.../jobs/futbol/live-corners.js:55-71`. `getVal = stat?.value ?? 0` (null→0) y
luego `liveData[fid] = { ...existing, corners }` **sin** piso monótono. Si el endpoint dedicado
trae un lado en null (común en varias ligas) → ese lado = 0 → sobrescribe un valor mayor ya
guardado (ej. 8-3 → 8-0). Es EXACTAMENTE el bug 8-1→8-0 que `live.js:1149-1159` corrige con
`Math.max` por-lado, pero `live-corners.js` NO lo aplica. Y emite `corners-update` por WS, que
`live-stats-context.js:47-57` aplica **reemplazando** `corners` → el contador baja en pantalla.
**Fix:** aplicar el mismo piso monótono (`Math.max` vs `existing.corners`) antes de escribir/emitir,
o reusar la función de `live.js`. *(Nota: el cron live-corners corre cada 30 min — el de live de
20s suele "tapar" el bug, pero entre medias puede verse el retroceso.)*

### Jobs `odds.js` y `live-corners.js` — resto correcto
`odds.js`: smart-budget con ventana [1er partido −2h, último], espaciado dinámico, smart-skip.
Bien (salvo OA4). `live-corners.js`: en lo demás (filtra live desde Redis, 1 fetch/fixture en
paralelo, emite WS) correcto.

---

## ARCHIVOS LEÍDOS COMPLETOS SIN HALLAZGOS NEGATIVOS (calidad correcta)
- `apps/.../jobs/futbol/daily.js`, `fixtures.js`: limpios, grace window de `started` huérfano
  correcta, bien documentados.
- `apps/.../jobs/futbol/analyze-batch.js`: **excelente** — `mapPool`, persistencia debounced,
  verificación explícita de persist en BD (arregló el bug "99/99 OK pero tabla vacía"),
  `setImmediate` para renovar el lock de BullMQ, `UnrecoverableError` para payload inválido,
  throw→retry ante cualquier fallo. (Comentario obsoleto "Dixon-Coles + stages 3-6" en `:28`.)
- `lib/mlb-stats-api.js`: API pública gratis, caché en Redis, shrinkage por IP del factor del
  pitcher, lineup de doble fuente (schedule hydrate → boxscore fallback). Sin issues.
- `lib/context-probabilities.js`: salvo CB1-bis, sólido (regla inviolable de cuota real,
  equivalencia de línea entera, atribución de bookmaker).
- `lib/api-football.js` `analyzeMatch`: orquestación correcta (salvo AF1-AF4 ya anotados).

> Nota de método: "sin hallazgos negativos" = sin bugs/latencia/parches relevantes en una
> lectura línea por línea; NO es una validación matemática del modelo (eso es otra auditoría).
- `lib/adn.js` (313): **fuente única de verdad** del evaluador (`buildActuals`). Maneja BIEN
  el sesgo null-vs-0 del denominador (stat omitida con bloque presente = 0; sin bloque = null).
  Puro, paridad train↔score. Es la prueba de que la divergencia AF1 está solo en el camino
  live/display, NO en el modelo.
- `lib/h2h.js` (129): niveles H2H + excepciones causales, point-in-time (cutoff), orient/flip
  para paridad. Puro, limpio.
- `lib/meta-features.js` (320): catálogo `MARKET_DEFS` (scalar + OU groups × líneas) +
  `buildMetaFeatures` + `predictWithModel` (logístico con imputación/estandarización). Paridad
  train/score, limpio.
- `lib/webpush.js` (144): **excelente** manejo de estados (410/404→expired, 401/403→VAPID,
  413→payload, 5xx→transitorio), métricas, `sendPushNotificationBulk` con `Promise.allSettled`.
- `lib/audit.js` (74): logging admin fire-and-forget, extrae IP/UA, sin PII. Correcto.
- `apps/.../notifier.ts` (113): alertas Telegram con dedup 1/min + purga del Map (anti-leak),
  escape HTML, timeout 5s. Correcto. La infraestructura de notificaciones/alertas es sólida.
- `apps/.../queues.ts` (96): reintentos por cola bien calibrados (analyze=5, live=1 fail-fast,
  retrain=2, raw-backfill=1), backoff exponencial, retención removeOnComplete/Fail. Correcto.
- `apps/.../jobs/futbol/lineups.js`: ventana T-45min, `deriveUsualXIOnTheFly` cacheado 24h,
  detección de titulares ausentes. Limpio.
- `apps/.../shared.ts`: shim de import dinámico (CommonJS↔ESM) bien documentado; `cronTargetDate`
  documenta y arregla el bug fixtures/daily de fechas. `lib/analysis-cache.js`: Map cliente con
  TTL 5min + eviction. Limpios.
- `lib/baseball-calibration.js` (188): isotónica por knots + interpolación lineal, caché 6h,
  `flattenProbabilitiesForStorage`. Limpio (consistente con la nota de memoria: el cuello es la
  discriminación del modelo Poisson, no la calibración).
- `lib/tournament-bracket.js` (184): Monte Carlo de bracket; empate→penales 50/50 correcto;
  rondas futuras con default neutro 40/25. Solo comentario obsoleto "Dixon-Coles" (`:7`).
- `lib/fetcher.js` (SWR con error enriquecido), `lib/utils.js` (`cn`): triviales, correctos.
- `app/ferney/Dashboard.jsx`: panel admin, poll 2s/`/api/admin/ferney` + 10s/`/api/admin/vps-stats`.
  Acciones (retry/enqueue/calibrate) vía API con `requireAdmin` server-side. 2s es algo agresivo
  para `/admin/status` (cuenta colas+jobs en cada tick) pero es 1 solo usuario admin → aceptable.
- `scripts/retry-failed-payments.js`: **dry-run por defecto**, `--execute` explícito, filtro por
  email, manejo de decline codes, param `text[]` correcto. Script de dinero bien hecho.

## PENDIENTE de lectura línea-por-línea (continúa en siguientes pasos)
Datos/helpers puros (bajo riesgo): `leagues.js`, `bookmakers.js`, `constants.js`, `utils.js`,
`market-labels.js`, `currency.js`, `timezone.js`, `descriptive-stats.js`, `h2h.js`,
`tournament-bracket.js`, `fetcher.js`, `analysis-cache.js`, `webpush.js`, `resend-email.js`,
`supabase-client.js`, `baseball-leagues.js`. Motor/ML: `context-engine.js` (1-520),
`meta-features.js`, `adn.js`, `feature-snapshot.js`, `baseball-features.js`, `baseball-ml.js`,
`baseball-calibration.js`, `baseball-combinada.js`, `raw-backfill.js`. Worker: jobs baseball
(analyze/live/finalize/fixtures/cleanup/retrain), futbol (lineups/live-corners/odds/cleanup/
retrain/raw-backfill/analyze-all-today), calibration, `schedulers.ts`, `queues.ts`, `shared.ts`,
`notifier.ts`, `logger.ts`, `env-bootstrap.ts`, `errors-log.js`. ~35 scripts restantes
(backfills/migraciones/training — offline, bajo riesgo en prod). JSX de páginas + componentes
(`chat-widget`, `live-stats-context`, `selected-markets-context`) + `admin/page.js` + páginas
auth + layouts.

---

## SUBSISTEMA: helpers — `lib/currency.js`, `lib/timezone.js` (leídos completos)

### CU1 — 🟠 Si la API de FX falla, el cobro usa el monto USD AS-IS en moneda local (pérdida de ingresos)
**Archivo:** `lib/currency.js:32-35` (`getExchangeRate` → `return 1` en error) + `:46-47`
(`convertAmount` usa ese rate). Si `open.er-api.com` está caído, `rate=1` y `convertAmount(15
USD, 'COP')` devuelve `{amount: 15, currency: 'COP'}`. En `lib/stripe.js:133` eso se cobra como
**15 COP ≈ $0.004** en vez de ~$15. Un usuario en moneda débil (COP/ARS/CLP) pagaría casi
nada durante un outage de FX. **Fix:** si la conversión falla, **cobrar en la moneda fuente
(USD)** —no "el número en moneda local"— o abortar el checkout con error. Nunca cambiar de
moneda sin convertir el importe.

### CU2 — 🟡 Caché de FX en memoria del proceso (no compartida, sin TTL de Redis)
**Archivo:** `lib/currency.js:6` (`rateCache = {}`). Per-proceso (web vs worker no comparten),
crece sin evicción (acotado por nº de pares de moneda). Coherente con A2/W5/MO2 (varias cachés
locales). Menor. **Fix:** Redis local con TTL 1h.

### TZ1 — `lib/timezone.js` correcto
Usa `Intl.DateTimeFormat('en-CA', {timeZone})` para fechas locales, regla "el partido pertenece
al día local del kickoff", rango UTC que cubre ±1 día. Sin bugs — resuelve correctamente los
"shows next day" históricos.

---

## SUBSISTEMA: MOTOR — `lib/context-engine.js` (608 líneas, leído completo)

### CE1 — 🟡 Carga de inputs hace consultas JSONB-path sobre `raw_api_payloads` (¿índices?)
**Archivo:** `lib/context-engine.js:497-503`. `teamFixtures` consulta
`WHERE endpoint='fixtures' AND (payload->'teams'->'home'->>'id' = $1 OR payload->'teams'->'away'->>'id' = $1)`
por cada equipo (×2 por partido). `raw_api_payloads` es la tabla de captura cruda (grande). Sin
**índices de expresión** sobre esos paths JSONB (o un GIN), cada análisis hace 2 full-scans de
una tabla potencialmente enorme × 100+ partidos en el batch nocturno. Es offline (2 AM, no
afecta latencia de usuario), pero puede alargar mucho el `analyze-batch`. **Fix:** índices de
expresión `((payload->'teams'->'home'->>'id'))` y `((payload->'teams'->'away'->>'id'))` con
`WHERE endpoint='fixtures'`, o una columna `team_ids int[]` materializada + GIN. *(Verificar
qué índices existen ya en la BD.)*

### CE2 — Motor bien diseñado (positivo)
`computeContext` es **puro** (paridad train↔runtime), niveles L1 H2H exacto → L2 ADN agregado
(sin inventar L3), capa de ruptura/veto con causas, ML direccional gated por
`CONTEXT_ML_ENABLED`, normalización de ternas 1X2, filtro de "línea negociable" (±3.5 de la
media), y persistencia eficiente de los ~1133 mercados con `jsonb_to_recordset` (un solo
INSERT…ON CONFLICT). Cachés de modelos en memoria con TTL (per-proceso, aceptable en worker).
Sin bugs de correctitud detectados en la lectura.

---

## SUBSISTEMA: NOTIFICACIONES — recorrido END-TO-END (detección → pantalla)

Cadena completa trazada: **(1)** worker `futbol-live` cada 20s detecta deltas (`extractLiveStats`
+ `buildEventBundle`) → **(2)** dedup por claves Redis con TTL por tipo (`alreadySent`/`markSent`)
→ **(3)** bundle 1-push-por-fixture/tick → **(4)** filtro por FAVORITOS + envío
(`sendBundledPushes` → `webpush.sendNotification` urgency:high) → **(5)** Service Worker
`public/sw.js` recibe `push` y hace `showNotification` → **(6)** telemetría `tShown`.

### NT1 — 🟠 Las notificaciones SOLO llegan si el usuario marcó el partido como FAVORITO
**Archivos:** `jobs/futbol/live.js:765-766` (`if (!favs.has(bundle.fixtureId)) return;` sobre
`user_favorites`) y `jobs/baseball/live.js:207,221` (sobre `baseball_user_favorites`). Es por
diseño, pero es **la causa #1 de "no me llegan notificaciones"**: un usuario que espera avisos
de goles no recibe nada salvo que haya marcado ⭐ cada partido. Si el producto pretende
"notificaciones de goles", debería existir un modo "seguir todos los de mis ligas" o un opt-in
global. Súbelo a decisión de producto.

### NT2 — 🟡 La telemetría `tShown` (detección→pantalla) está MUERTA
**Archivos:** `jobs/futbol/live.js:332-334` (el event-log promete `tShown` vía
`/api/telemetry/live-shown`) + `server.ts:305-309` (calcula `latencyShownMs`). **Ese endpoint
NO existe** (`app/api/telemetry/` no está) y **ningún cliente/SW lo llama** (`sw.js` no reporta
nada tras `showNotification`). ⇒ `tShown`/`latencyShownMs` son SIEMPRE null: no se puede medir
la latencia real "gol→pantalla" (justo la métrica del objetivo "tiempo real"). **Fix:** crear
`POST /api/telemetry/live-shown` + que el SW (o la página) lo invoque al pintar el evento; o
borrar la promesa del event-log para no aparentar una observabilidad que no existe.

### NT3 — 🔴/🟠 `resend-email.js` TAMBIÉN envía la contraseña en texto plano (2º sitio de R11)
**Archivo:** `lib/resend-email.js:10,62` — `sendWelcomeEmail({...password})` incrusta
`<span class="value">${password}</span>`. Es una **segunda** implementación del email de
bienvenida con la misma fuga que `zeptomail.js` (R11). Hay DOS proveedores de email con la
misma mala práctica. **Fix:** quitar `password` de AMBOS y de sus firmas. (Confirmar cuál usa
`register` hoy —importa de `zeptomail`— y borrar/!usar el otro.)

### NT4 — Corrección de fidelidad: baseball SÍ envía push (me equivoqué antes)
En un turno anterior insinué que baseball era "solo WS". **Falso:** `jobs/baseball/live.js:16,221`
usa `sendPushNotification` con su propio gating de favoritos (`baseball_user_favorites`). Tanto
fútbol como baseball mandan push.

### NT5 — 🟡 Doble infraestructura de email (Resend + ZeptoMail)
`lib/resend-email.js` (chat/tickets, `RESEND_API_KEY`, FROM `onboarding@resend.dev`) y
`lib/zeptomail.js` (bienvenida/plan/reset). Dos proveedores SMTP configurados en paralelo;
`resend-email.sendWelcomeEmail` parece redundante con el de zeptomail. Consolidar en uno.

### NT7 — 🟡 `incrementApiCallCount` se llama N veces en bucle con `await` (cada 20s)
**Archivos:** `jobs/futbol/live.js:1308`, `jobs/futbol/lineups.js:251`,
`jobs/futbol/live-corners.js:82` → `for (let i=0;i<apiCalls;i++) await incrementApiCallCount();`.
Son N `INCR` a Redis **secuenciales** (uno por llamada API contada) en la ruta caliente de live
(cada 20s). **Fix:** `incrementApiCallCount(n)` con un solo `INCRBY`.

### NT8 — Orden: el broadcast WS in-app va al FINAL de `runLive` (tras todos los fetches)
**Archivo:** `jobs/futbol/live.js:1303` (`triggerEvent('live-scores','update')`) ocurre después
de needsEventsFetch + needsStatsFetch + stale-detection (varios segundos de llamadas API),
mientras el push (`sendBundledPushes:1176`) es fire-and-forget antes. ⇒ el marcador in-app por
WS puede llegar **después** que el push. No es bug, pero si quieres el WS más rápido, emitir un
primer broadcast con los marcadores del feed principal ANTES de los fetches de detalle.

### NT9 — `baseball/live.js` (328) leído completo: limpio
Paralelo a fútbol: cursor `atBatIndex` por juego (HR/K dorado sin reprocesar), dedup por tipo
(carrera 30m, HR 60m, inning 2h), gating `baseball_user_favorites`, at-least-once, purga de
expirados, WS `baseball-live`/`update` + emite marcadores aun sin juegos en vivo (para cerrar
finales). Cron cada 60s, MLB Stats API gratis (sin cuota). Sin bugs.

### NT6 — Calidad del pipeline de push (positivo, confirmado leyéndolo entero)
La detección (`buildEventBundle`) está muy currada: deltas monótonos de córner (`Math.max`
anti-retroceso), dedup `evKey` sin minuto (robusto ante reordenamientos de la API), TTL por
tipo (gol/roja 2h, córner/VAR 90s), at-least-once (marca dedup solo tras entrega), urgency:high
para iOS, purga de endpoints expirados. El SW (`sw.js`) maneja `push`/`notificationclick`/
`pushsubscriptionchange` (renovación dual) correctamente. El floor de latencia real gol→push ≈
**5–30s** (20s cron + entrega FCM/APNs), nunca 1ms.

---

## MÁS ARCHIVOS LEÍDOS COMPLETOS

### EL1 — 🟡 `errors-log.js`: read-modify-write no atómico (puede perder errores) + comentario "Upstash"
**Archivo:** `apps/.../errors-log.js:34-42`. `logError` hace `redisGet` (array hasta 500) →
`unshift` → `redisSet` (reescribe todo). No es atómico. En `analyze-batch` los `logError` se
disparan dentro de `mapPool` concurrencia 8 → dos `logError` simultáneos leen el mismo array y
uno pisa al otro (se pierde un error del log). Es diagnóstico, severidad baja, pero real.
Comentario `:5-8` dice "Upstash Redis list" — ya es Redis local (obsoleto). **Fix:** usar
`LPUSH`+`LTRIM` nativos de Redis (atómicos) en vez de serializar el array completo.

- `lib/descriptive-stats.js` (114): helpers puros de forma L5 / H2H / goal-timing para los
  widgets. Matemática correcta (`P(≥1)=1−(1−pH)(1−pA)`). `calculateGoalAverages` exportada quizá
  sin uso (verificar). Limpio.
- `apps/.../jobs/baseball/analyze.js` (282): espejo de `analyze-batch` (mapPool, ML override
  gated por `featureIndex`+modelos activos con degradación grácil a Poisson, calibración,
  verificación de persist, throw→retry, `setImmediate`). Limpio.

---

## SUBSISTEMA: jobs baseball/cleanup (más worker)

### BB-UP1 — 🟠 CINCO `upsert` SIN `onConflict` (la landmine documentada) — barrido completo hecho
Vía el proxy `pgAdmin` (`lib/db.js:357-359`), un `upsert` sin `onConflict` se traduce a
`ON CONFLICT DO NOTHING`. Si la tabla tiene UNIQUE → la 2ª escritura en adelante **no actualiza
nada** (dato congelado en el 1er insert); si NO tiene UNIQUE → **inserta duplicados** y los
`.maybeSingle()` fallan. Barrido de TODOS los upserts (los de **fútbol están BIEN**, todos con
onConflict — sanity-cache, finalize, favorites, hide, register, push). Los que FALLAN, todos en
baseball + calibración:
1. 🟠 **`calibration/baseball.js:178`** (`app_config` knots) — **el más grave**: la calibración
   diaria computa knots nuevos y los "guarda", pero el upsert sin onConflict es **no-op** tras
   el 1er guardado → **la calibración de baseball queda CONGELADA para siempre**. Explica el
   síntoma de `baseball_calibration_modelo.md` ("el modelo no discrimina"): aunque recalibres,
   los knots nunca cambian. **Fix:** `{ onConflict: 'key' }` (o usar `setAppConfig` de
   supabase-cache.js que ya lo trae).
2. 🟠 **`baseball/live.js:296`** (`baseball_match_results`) — marcador en vivo congelado tras el
   1er tick (o filas duplicadas cada 60s). **Fix:** `{ onConflict: 'fixture_id' }`.
3. 🟡 **`baseball/fixtures.js:42`** (`baseball_match_schedule`) — schedule nunca se refresca.
   **Fix:** `{ onConflict: 'date' }`.
4. 🟡 **`baseball/favorites/route.js:36`** (`baseball_user_favorites`) y **`baseball/hidden/route.js:26`**
   (`baseball_user_hidden`) — sin onConflict; re-marcar favorito/oculto no es idempotente
   (duplica filas o no escribe). **Fix:** `{ onConflict: 'user_id,fixture_id' }`.
Es la misma clase de bug de `pgadmin_upsert_onconflict_gotcha.md` que ya causó el bug de player
props. *(Confirmado por barrido `grep` de los ~25 upserts del repo: solo estos 5 carecen de
onConflict; todo el lado fútbol está correcto.)*

**CONFIRMADO #1 (calibración) leyendo `calibration/baseball.js` completo:** `runBaseballCalibration`
computa knots correctos (isotónica PAV + shrinkage `SHRINKAGE_PRIOR_N=10` + Laplace + anclaje de
bordes [0,0]/[100,100] — bien hecho, arregla el bug histórico de extrapolación −468pp) y devuelve
`{before, after, diff}` que el panel /ferney muestra como "calibrado, Δ=X". PERO el
`upsert({key,value} /* sin onConflict */)` de `:178` es no-op tras el primer guardado → **el valor
en `app_config[calibration_baseball_v1]` nunca se actualiza**. El panel "miente" (dice que
recalibró) y el runtime usa los primeros knots para siempre. Existe `setAppConfig()` en
`supabase-cache.js` que SÍ pasa `{onConflict:'key'}` — bastaría usarla. Es de los hallazgos más
insidiosos: el síntoma ("no discrimina") parece del modelo, pero la raíz es esta persistencia rota.

### Worker infra limpia (leída completa)
- `schedulers.ts` (118): BullMQ Job Schedulers nativos, idempotentes, limpieza de
  `STALE_SCHEDULER_IDS`, TZ España disparo + TZ Colombia jornada, ciclo nocturno bien orquestado
  (finalize→calibrate→retrain→fixtures/daily). **Nota:** comentario `:57-59` dice odds "7
  llamadas/día" pero `odds.js` usa `ODDS_BUDGET=2` (doc desfasada).
- `env-bootstrap.ts` (80): carga `.env` antes de cualquier import (orden ESM), doble fuente +
  override, fail-fast si falta `DATABASE_URL`. Documenta/arregla bugs de rutas. Bien hecho.
- `logger.ts`: Pino multistream (stdout + LOG_FILE), pretty en dev. `baseball/cleanup.js`: borra
  baseball cache 7/30/60d (predictions de calibración NO se borran → OK). `futbol/retrain.js`
  (capture→train, gated `FUTBOL_RETRAIN_ENABLED`) y `baseball/retrain.js` (reenrich→train, throw
  si falla): limpios.
- `lib/baseball-ml.js` (107): inferencia logística (paridad train↔runtime), override in-place de
  los 3 mercados entrenados, gated por modelos activos. `lib/market-labels.js` (62): etiquetas
  legibles puras por market_key. Limpios.
- `lib/baseball-features.js` (282): feature engineering point-in-time (guards estrictamente-
  anterior anti-leakage, cursor para boxscores ~810MB, fallback ERA temporada-1). Paridad
  train↔runtime. Limpio (carga histórico en RAM por run, offline → aceptable).
- `lib/zeptomail.js` (194) leído completo: **confirma R11** — `sendWelcomeEmail:107` mete
  `${password}` en claro en el HTML (es el que usa `register`). `sendPlanActivatedEmail`/
  `sendPasswordResetEmail` correctos (no exponen password; reset por token con expiry 1h). Base
  template OK.
- `lib/supabase-client.js` (14): cliente browser Supabase (anon key). Tras la migración a auth
  PG nativo, **probablemente código muerto** (el frontend usa `/api/auth/*`, no este cliente) →
  verificar imports y borrar. `lib/feature-snapshot.js`: builder point-in-time PURO, null-safe,
  anti-leakage; **solo lo usan scripts de backfill offline** (la ruta viva se retiró con DC).
- `lib/raw-backfill.js` (368): motor de captura cruda idempotente (`ON CONFLICT DO NOTHING`
  apropiado aquí — payloads inmutables), `pg.Pool` directo, mapPool acotado. Offline/CLI + job
  4am. Limpio. (Nota: `getTeamsForHalf` lee de `match_predictions`, que el motor de contexto ya
  no puebla → solo afecta al CLI one-shot de captura total, histórico.)
- `lib/constants.js` (14): `MIN_DISPLAY_ODDS=1.20`. Trivial, correcto.
- `lib/leagues.js` (196): tabla de ~60 ligas + `isYouthTeam` (regex YOUTH_TEAM_RE consistente
  con `live.js`/`api-football.js`) + FLAGS. Datos, sin lógica de riesgo. Limpio.

### SCRIPTS (leídos los de riesgo)
- `scripts/seed-admin.js`: **confirma MO1** (`bcrypt.hash('Pump0517*',12)` hardcodeado para el
  admin) **y es CÓDIGO MUERTO** — crea un `cfaUser` en **Sanity** (eliminado). Doble razón para
  borrarlo; el literal de contraseña sigue en el historial git → rotar.
- `scripts/migrate-supabase-users-to-pg.js`: migración one-shot Supabase Auth → `users` PG.
  Idempotente (`xmax=0` insert/update, `password_hash=NULL`→reset). Limpio. (Apunta a
  `/api/auth-pg/forgot-password` → confirma que el set `auth-pg/*` se usó para la migración,
  M4: hoy duplica `/api/auth/*`.)

### BARRIDO FINAL (scripts offline + JSX) — técnica dirigida, no línea-por-línea
Para la cola (≈28 scripts de backfill/migración/entrenamiento + cuerpos JSX de render), apliqué
escaneos dirigidos (la técnica correcta para ese tipo de archivo) en vez de lectura íntegra:
- **Secretos hardcodeados** en todo el repo → solo `seed-admin.js` (MO1). El resto lee de
  `process.env`.
- **Secretos en cliente** (`'use client'` usando `process.env.X` no-`NEXT_PUBLIC`) → **ninguno**.
  El navegador solo ve `NEXT_PUBLIC_*` (la fuga real ya está en C1: `NEXT_PUBLIC_WORKER_SECRET`).
- **SQL destructivo sin WHERE** en scripts → solo `backfill-referee-stats.js:123`
  (`DELETE FROM referee_stats` completo, patrón rebuild). 🟡 Riesgo: si se interrumpe tras el
  DELETE, deja la tabla vacía hasta recomputar; es manual, pero conviene envolver en transacción.
  `train-baseball-meta-models.js` hace `UPDATE prediction_models SET active=FALSE/TRUE` (patrón
  "desactivar viejos / activar nuevos", normal).
- **XSS / `dangerouslySetInnerHTML`** → solo en `*/loading.js` (CSS **estático**) y `app/page.js:120`
  (`f.icon` de un **array estático** local de la landing). **No hay** inyección de datos de
  usuario/CMS → seguro.

> **Honestidad sobre el alcance:** los ≈28 scripts offline y los cuerpos JSX de render NO se
> leyeron línea-por-línea íntegra; se cubrieron con estos escaneos dirigidos (secretos, SQL
> destructivo, XSS, fugas de env en cliente) que son lo que de verdad porta riesgo en esos
> archivos. Las **capas de datos/efectos/realtime** de las páginas grandes SÍ se leyeron entero.
> Si quieres el line-by-line literal de algún script o página concreta, dímelo y lo leo.

### CB1-ter — Inconsistencia DENTRO de baseball: producto vs promedio en "prob. combinada"
**Archivos:** `lib/baseball-combinada.js:66,106` (`buildBaseballApuestaDelDia` y
`buildCustomBaseballCombinada`) usan **PRODUCTO** `reduce((a,r)=>a*(r.probability/100),1)` →
**correcto**. Pero `buildBaseballCombinada` en `lib/baseball-model.js:683` usa **PROMEDIO** (CB1/
BM1). Así, en baseball, la "probabilidad combinada" de la **tarjeta por-juego** (promedio,
infla) difiere de la del **agregado Apuesta del Día** (producto, real) para las mismas
selecciones. Confirma que CB1 no es solo "está mal en 3 sitios" sino que **coexisten ambas
fórmulas** → el usuario ve cifras incoherentes entre widgets. Unificar todo a producto.

### Jobs limpios de este lote
- `futbol/cleanup.js`: borra `fixtures_cache`/`match_schedule` viejos; **NO** borra
  `match_analysis` (decisión correcta: es histórico del modelo). Nota menor: el delete de
  `app_config` con `key LIKE 'dailyBatch-%'` probablemente no borra nada (el flag dailyBatch
  vive en Redis, no en app_config) → cleanup muerto inofensivo.
- `futbol/analyze-all-today.js`: enfoque UNIÓN (nunca arranca de cero → si stalla no borra los
  99 análisis válidos), debounced persist, `force` propagado, `setImmediate`. Bien hecho.
- `baseball/finalize.js`: 1 llamada por fecha, ventana 365d, cap 200 fechas/run, mapPool. Limpio.

## NOTAS DE FÍSICA (para fijar expectativas de "tiempo real")
- Piso de datos en vivo = **20s** (cron `futbol-live-20s`) + RTT API-Football. El WS no
  lo mejora; solo evita el poll del cliente. Para bajar de 20s hay que subir frecuencia
  de poll → choca con cuota 150000/día de API-Football.
- Piso de red navegador↔VPS = RTT geográfico (Colombia↔servidor). Irreducible por código.
- Lo optimizable por código: queries duplicadas (M1), doble polling (A3), payloads
  grandes, bloqueos en el render. Eso es lo que perseguimos.

---

*(Documento en construcción — se irá ampliando subsistema por subsistema.)*
