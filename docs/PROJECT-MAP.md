# CF Análisis — mapa del proyecto

Actualizado: 2026-07-29 · Commit base: `44c76aa`

## Identidad y stack

CF Análisis vende acceso recurrente a análisis deportivos, marcadores, combinadas y mercados estadísticos. Es una PWA móvil primero, servida por Next.js 14 desde el VPS mediante PM2/Caddy.

| Área | Implementación |
|---|---|
| Web/API | Next.js App Router, React 18, JavaScript |
| Datos | PostgreSQL 17, `pg`, wrapper `pgAdmin` |
| Auth | bcrypt, JWT HS256 y sesiones revocables en PostgreSQL |
| Cache/realtime | Redis + worker TypeScript/WebSocket |
| Pagos | Stripe mundial; Mercado Pago en Colombia |
| Email | Resend/ZeptoMail según plantilla |
| Deploy | GitHub Actions → `/apps/futbol` → build standalone → PM2 |

## Mapa de rutas

| Ruta | Archivo | Auth | Responsabilidad |
|---|---|---:|---|
| `/` | `app/page.js` | No | Home, precios localizados e inicio de compra |
| `/sign-up` | `app/sign-up/[[...sign-up]]/page.js` | No | Registro y sesión inmediata |
| `/sign-in` | `app/sign-in/[[...sign-in]]/page.js` | No | Login PG |
| `/forgot-password` | `app/forgot-password/page.js` | No | Solicitud de recuperación |
| `/reset-password` | `app/reset-password/page.js` | No | Cambio de contraseña con token |
| `/planes` | `app/planes/page.js` | Sí | Selección y apertura de checkout |
| `/dashboard` | `app/dashboard/layout.js`, `page.js` | Plan activo | Partidos, análisis y combinadas |
| `/dashboard/analisis/[id]` | `app/dashboard/analisis/[id]/page.js` | Plan activo | Análisis de fútbol |
| `/dashboard/baseball` | `app/dashboard/baseball/page.js` | Plan activo | Producto de béisbol |
| `/admin` | `app/admin/` | Admin/owner | Operación y clientes |
| `/ferney` | `app/ferney/` | Privada | Auditoría del propietario |

## Endpoints críticos

| Método y ruta | Archivo | Consumidor | Datos/efecto |
|---|---|---|---|
| `POST /api/register` | `app/api/register/route.js` | Registro | Crea `users`, perfil y sesión |
| `POST /api/auth/login` | `app/api/auth/login/route.js` | Login | Valida bcrypt y crea sesión |
| `GET /api/auth/session` | `app/api/auth/session/route.js` | Provider | Devuelve usuario/perfil actual |
| `POST /api/auth/logout` | `app/api/auth/logout/route.js` | UI | Revoca sesión y borra cookie |
| `GET /api/detect-country` | `app/api/detect-country/route.js` | Home/planes | Resuelve país por cabecera/IP |
| `GET /api/currency` | `app/api/currency/route.js` | Home/planes | Convierte los cinco planes |
| `POST /api/checkout` | `app/api/checkout/route.js` | Planes | Crea PaymentIntent Stripe |
| `POST /api/webhook` | `app/api/webhook/route.js` | Stripe | Activa plan y crea recurrencia |
| `POST /api/mercadopago/subscribe` | `app/api/mercadopago/subscribe/route.js` | MP Brick | Crea preapproval/pago local |
| `POST /api/mercadopago/webhook` | `app/api/mercadopago/webhook/route.js` | Mercado Pago | Confirma y activa el plan |
| `GET /api/fixtures` | `app/api/fixtures/route.js` | Dashboard | Partidos y análisis diarios |
| `GET /api/match/[id]` | `app/api/match/[id]/route.js` | Análisis | Detalle estadístico |
| `GET/POST /api/refresh-live` | `app/api/refresh-live/route.js` | Dashboard | GET lee Redis; POST fuerza proveedor |
| `/api/cron/*` | `app/api/cron/` | Cron/worker | Ingesta, análisis y finalización |

El resto de endpoints se agrupa en `app/api/admin`, `baseball`, `chat`, `favorites`, `push`, `quota`, `tickets` y `user`.

## Modelo de datos

Las migraciones viven en `scripts/`. Tablas clave:

- `users`: email, hash, verificación y bloqueos.
- `auth_sessions`: sesión revocable, expiración, agente/IP y último uso.
- `user_profiles`: rol, plan, estado, IDs de Stripe/MP y preferencias.
- `fixtures_cache`, `match_schedule`, `match_results`, `match_analysis`, `match_predictions`: núcleo de fútbol.
- `baseball_*`: fixtures, resultados, análisis, predicciones, favoritos y ocultos.
- `combinadas`, `tickets`, `chat_messages`, `push_subscriptions`.
- Esquema `model`: entidades, hechos, perfiles y señales del motor estadístico.

`lib/supabase.js` ya no conecta Supabase: conserva la API antigua y delega en `lib/db.js`.

## Flujos clave

### Registro y compra

1. Home obtiene `/api/detect-country` y `/api/currency`.
2. El CTA genera `plan` validado + `intent` opaca (`lib/purchase-flow.js`).
3. Registro llama `/api/register`; `signupUser` crea usuario, perfil, sesión y cookie.
4. Registro redirige a `/planes?checkout=<plan>&intent=<id>`.
5. `/planes` valida auth e intención, resuelve país/moneda y consume la intención una sola vez.
6. Colombia abre `MercadoPagoModal`; otros países crean PaymentIntent y abren `PaymentModal`.
7. Los webhooks activan `user_profiles`; el cliente no puede activarse por sí mismo.
8. Si el email ya existe, registro y login conservan plan e intención.

### Stripe

`app/api/checkout/route.js` valida usuario, email y plan → `lib/stripe.js` calcula el monto desde la fuente servidor → PaymentElement confirma → webhook firmado activa acceso → se crea recurrencia idempotente.

### Mercado Pago

El Brick recoge el método → `subscribe` valida sesión/plan y recalcula COP en servidor → tarjeta crea preapproval; PSE/Efecty crea pago → webhook relee el recurso real en MP y actualiza el perfil.

### Auth

`lib/auth-pg.js` crea/verifica usuarios y sesiones. `lib/auth-session.js` firma `cf_session`. `middleware.js` valida firma/expiración; layouts y endpoints vuelven a comprobar la sesión contra PostgreSQL.

Tras login o registro, las pantallas cliente llaman `refreshSession()` antes de navegar. El layout autenticado también entrega nombre y email iniciales a `DashboardHeader`, por lo que avatar y menú de salida no dependen de una recarga posterior.

### Realtime

`apps/cfanalisis-worker` ingiere y publica actualizaciones. El cliente WebSocket
reenvía todos sus topics al abrir o reconectar. El dashboard usa esos eventos
como fuente primaria; si no recibe eventos durante 50 s, su watchdog consulta
solo el snapshot Redis mediante `GET /api/refresh-live`, con una única petición
en vuelo y separación mínima de 20 s. La revalidación completa de fixtures queda
como respaldo cada 5 min únicamente para hoy y con el WebSocket caído.

### Rendimiento del dashboard

La lista de partidos y la lista interna de “Apuesta del día” están virtualizadas:
solo se montan las filas próximas al viewport, independientemente de que existan
20, 100, 400 o más partidos. Una tarjeta analizada cerrada no monta mercados,
probabilidades ni jugadores; al abrirse, `ResizeObserver` mide solo esa fila sin
compensar el scroll. Las tarjetas están memoizadas y reciben handlers estables.

`GET /api/fixtures` usa `MGET` para documentos Redis, una consulta PostgreSQL
por lote para los `live_stats` ausentes y filtra análisis, cuotas, standings y
snapshots live a los IDs de la jornada antes de serializar la respuesta.

## Dependencias compartidas

- `app/globals.css`: sistema visual de Home, auth, planes, checkout y dashboard.
- `app/dashboard/components/DashboardHeader.js`: encabezado autenticado compartido.
- `app/dashboard/components/SportToggle.js`: selector desplegable y precarga de fútbol/béisbol.
- `app/dashboard/components/AnalysisFullModal.js`: carcasa compartida del análisis completo con scroll vertical nativo.
- `components/providers.js`: sesión global y sincronización de zona horaria.
- `lib/db.js`: pool y compatibilidad de queries; afecta casi toda la app.
- `lib/auth-pg.js` y `lib/auth-session.js`: cualquier cambio afecta login, layouts y APIs.
- `lib/stripe.js`: fuente única de IDs, precios, periodos y moneda base.
- `lib/currency.js`: conversión y fallback de cobro.
- `lib/redis.js`: cache, deduplicación y realtime.
- `lib/purchase-flow.js`: whitelist e intención de compra entre Home/auth/planes.

## Variables de entorno

| Grupo | Variables |
|---|---|
| PostgreSQL | `DATABASE_URL`, `DATABASE_SSL`, `DATABASE_POOL_MAX` |
| Auth | `AUTH_PROVIDER`, `AUTH_JWT_SECRET`, `NEXTAUTH_SECRET` |
| Redis | `LOCAL_REDIS_HOST`, `LOCAL_REDIS_PORT`, contraseñas opcionales |
| Stripe | `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Mercado Pago | `MP_ENV`, claves públicas/privadas y `MP_WEBHOOK_SECRET` |
| App/worker | `NEXT_PUBLIC_APP_URL`, `WORKER_URL`, secretos y URLs WS |
| Datos | `FOOTBALL_API_KEY`, `THE_ODDS_API_KEY` |
| Email/push | `RESEND_API_KEY`, `FROM_EMAIL`, VAPID |

Nunca documentar valores. Las `NEXT_PUBLIC_*` requieren rebuild.

## Gotchas vivos

- 2026-07-29: el entorno local usa túneles al VPS; auth y pagos son producción real.
- 2026-07-29: el checkout automático requiere deduplicación persistente ante Strict Mode/Fast Refresh.
- 2026-07-29: solo el plan viaja por URL; el servidor vuelve a calcular precio, moneda y proveedor.
- 2026-07-29: `/planes` usa un escenario fijo; scroll, teclado y swipe cambian la tarjeta activa sin crear una lista vertical.
- 2026-07-29: el dashboard recibe identidad inicial desde su layout de servidor y precarga ambas rutas deportivas.
- 2026-07-29: el análisis completo de Fútbol y Baseball se abre en un modal
  compartido como documento vertical continuo. Todas las secciones permanecen
  en el flujo normal y el único contenedor desplazable usa el comportamiento
  nativo de rueda, trackpad, teclado e iOS/Android, sin controlador de gestos,
  escenas, progreso virtual ni scroll-snap.
- 2026-07-29: `BrandLogoMedia` usa `/logo-metalizado-fast.webm` (512 px/15 fps,
  VP9 con plano alfa real) y `/logo-metalizado-alpha-fast.webp` como primer
  frame/fallback estático en WebKit/iOS. Un coordinador permite reproducir un
  solo logo a la vez.
- 2026-07-29: `analysis:{date}` es caché canónica global escrita únicamente
  por el worker; una respuesta de `/api/fixtures` jamás debe sobrescribirla con
  el subconjunto visible de una zona horaria. La ruta contrasta siempre
  `analyzed-ids:{date}` y días adyacentes para autorreparar caches parciales y
  cubrir partidos nocturnos que cambian de jornada entre Bogotá y Madrid.
- 2026-06: los nombres `supabaseAdmin`/`createSupabaseServerClient` son shims PG, no Supabase activo.
- El standalone necesita copiar `.env`, `public/` y enlazar `.next/static` como define el workflow.
