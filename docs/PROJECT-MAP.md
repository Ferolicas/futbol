# CF Análisis — mapa del proyecto

Actualizado: 2026-08-02 · Base auditada: frecuencia cruda exacta y tope de 95% exclusivamente visual

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
| `/pago/estado` | `app/pago/estado/` | Sí | Confirmación durable y recuperación del pago |
| `/dashboard` | `app/dashboard/layout.js`, `page.js` | Plan activo | Partidos, análisis y combinadas |
| `/dashboard/analisis/[id]` | `app/dashboard/analisis/[id]/page.js` | Plan activo | Análisis de fútbol |
| `/dashboard/baseball` | `app/dashboard/baseball/page.js` | Plan activo | MLB, Triple-A, Double-A, High-A, Single-A y Rookie |
| `/dashboard/baloncesto` | `app/dashboard/baloncesto/page.js` | Plan activo | Partidos NBA y NCAA |
| `/dashboard/futbol-americano` | `app/dashboard/futbol-americano/page.js` | Plan activo | NFL, NCAA FBS y NCAA FCS |
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
| `POST /api/checkout` | `app/api/checkout/route.js` | Planes | Reserva intento y crea/reutiliza suscripción Stripe |
| `POST /api/webhook` | `app/api/webhook/route.js` | Stripe | Confirma factura y activa acceso |
| `POST /api/mercadopago/subscribe` | `app/api/mercadopago/subscribe/route.js` | MP Brick | Crea preapproval/pago local |
| `POST /api/mercadopago/webhook` | `app/api/mercadopago/webhook/route.js` | Mercado Pago | Confirma y activa el plan |
| `GET /api/payments/status` | `app/api/payments/status/route.js` | Estado de pago | Relee proveedor y devuelve estado real |
| `DELETE /api/payments/attempt` | `app/api/payments/attempt/route.js` | Checkout/estado | Cancela primero en proveedor y libera intento |
| `POST /api/payments/cancel` | `app/api/payments/cancel/route.js` | Cuenta | Cancela renovación conservando periodo pagado |
| `GET/POST /api/cron/payments` | `app/api/cron/payments/route.js` | Cron VPS | Reconcilia operaciones, perfiles y emails |
| `GET/POST /api/cron/publish-combinada` | `app/api/cron/publish-combinada/route.js` | n8n | Elige y guarda la apuesta Telegram dentro de las reglas comerciales |
| `GET /api/pick-image` | `app/api/pick-image/route.js` | n8n/Telegram | Renderiza la tarjeta PNG sin IA, con hasta tres selecciones y escudos |
| `GET /api/fixtures` | `app/api/fixtures/route.js` | Dashboard | Partidos y análisis diarios |
| `GET /api/match/[id]` | `app/api/match/[id]/route.js` | Análisis | Detalle estadístico |
| `GET/POST /api/refresh-live` | `app/api/refresh-live/route.js` | Dashboard | GET lee Redis; POST fuerza proveedor |
| `GET /api/sports/[sport]/fixtures` | `app/api/sports/[sport]/fixtures/route.js` | Baloncesto/NFL/NCAA | Jornada localizada, competiciones y análisis persistido |
| `POST /api/sports/[sport]/analyze` | `app/api/sports/[sport]/analyze/route.js` | Baloncesto/NFL/NCAA | Encola análisis sin ejecutar trabajo pesado en web |
| `GET /api/sports/[sport]/match/[id]` | `app/api/sports/[sport]/match/[id]/route.js` | Baloncesto/NFL/NCAA | Detalle y evidencia almacenados |
| `GET /api/sports/[sport]/quota` | `app/api/sports/[sport]/quota/route.js` | Operación interna | Presupuestos separados por proveedor; no se muestra al cliente |
| `/api/cron/*` | `app/api/cron/` | Cron/worker | Ingesta, análisis y finalización |

El resto de endpoints se agrupa en `app/api/admin`, `baseball`, `chat`, `favorites`, `push`, `quota`, `tickets` y `user`.

## Modelo de datos

Las migraciones viven en `scripts/`. Tablas clave:

- `users`: email, hash, verificación y bloqueos.
- `auth_sessions`: sesión revocable, expiración, agente/IP y último uso.
- `user_profiles`: rol, plan, estado, IDs de Stripe/MP y preferencias.
- `payment_attempts`: intención durable, recurso del proveedor, estado y entrega de email.
- `payment_webhook_events`: idempotencia persistente y reintentos de webhooks.
- `payment_exchange_rates`: última tasa EUR→COP válida para tolerar caídas del proveedor FX.
- `fixtures_cache`, `match_schedule`, `match_results`, `match_analysis`, `match_predictions`: núcleo de fútbol.
- `baseball_*`: MLB/MiLB más hechos, jugadores, predicciones y pesos empíricos
  propios en `baseball_engine_*`.
- `basketball_*`: calendario, análisis y hechos NBA/NCAA; no consulta tablas de
  fútbol, béisbol ni fútbol americano.
- `american_football_*`: calendario, análisis y hechos NFL/FBS/FCS; no consulta
  tablas de fútbol, béisbol ni baloncesto.
- `combinadas`, `combinada_dia`, `tickets`, `chat_messages`, `push_subscriptions`.
- Esquema `model`: entidades, hechos, perfiles y señales del motor estadístico.
- `raw_api_payloads` + `api_capture_failures`: crudo válido e histórico durable
  de reintentos; un error HTTP/rate-limit nunca se guarda como evidencia.
- `prediction_models` + `market_segment_diagnostics`: pesos versionados del
  motor y validación fuera de muestra por mercado, dirección y línea exacta.

`lib/supabase.js` ya no conecta Supabase: conserva la API antigua y delega en `lib/db.js`.

## Flujos clave

### Registro y compra

1. Home obtiene `/api/detect-country` y `/api/currency`.
2. El CTA genera `plan` validado + `intent` opaca (`lib/purchase-flow.js`).
3. Registro llama `/api/register`; `signupUser` crea usuario, perfil, sesión y cookie.
4. Registro redirige a `/planes?checkout=<plan>&intent=<id>`.
5. `/planes` valida auth e intención, resuelve país/moneda y consume la intención una sola vez.
6. Colombia abre `MercadoPagoModal`; otros países crean una suscripción incompleta y abren `PaymentModal`.
7. Cada operación usa un UUID durable; reintentos, dos pestañas y respuestas perdidas reutilizan el mismo recurso.
8. Webhook o reconciliación directa releen el proveedor y activan `user_profiles` de forma transaccional; el cliente no puede activarse por sí mismo.
9. `/pago/estado` confirma sin volver a cobrar. Para cambiar de método cancela primero el recurso pendiente en el proveedor.
10. Si el email ya existe, registro y login conservan plan e intención.

### Stripe

`app/api/checkout/route.js` valida sesión, plan y geografía → reserva `payment_attempts` → `lib/stripe.js` crea la suscripción con `default_incomplete`, precio recurrente calculado en servidor e idempotency key estable → PaymentElement confirma la primera factura → webhook firmado o reconciliador activa el mismo recurso que renovará. Nunca existe un cobro nuevo separado de la suscripción.

### Mercado Pago

El Brick recoge el método → `subscribe` valida sesión/plan/geografía y recalcula COP en servidor → tarjeta crea preapproval; PSE/Efecty crea pago con los datos reales exigidos por MP → webhook o `/api/payments/status` releen el recurso real. Un preapproval `authorized` no da acceso hasta encontrar un cobro `approved`. MP también entrega renovaciones por el topic genérico `payment`; el handler conserva el ID del preapproval y el reconciliador contrasta tanto Invoices como Payments API, porque la primera puede tardar en indexar.

### Fiabilidad de pagos

`lib/payment-store.js` serializa la activación con advisory lock y confirma perfil + intento en una sola transacción. Los cambios de estado están ligados al proveedor y al ID de suscripción vigente: un webhook atrasado no puede pisar una compra posterior. `lib/payment-reconcile.js` recupera webhooks perdidos, timeouts y respuestas cortadas. `scripts/run-payment-reconcile.sh` llama el cron cada dos minutos; perfiles sanos se verifican cada seis horas y `past_due` cada quince minutos para no castigar APIs externas. Los emails de activación se reclaman una sola vez y se reintentan hasta seis veces.

### Auth

`lib/auth-pg.js` crea/verifica usuarios y sesiones. `lib/auth-session.js` firma `cf_session`. `middleware.js` valida firma/expiración; layouts y endpoints vuelven a comprobar la sesión contra PostgreSQL.

Tras login o registro, las pantallas cliente llaman `refreshSession()` antes de navegar. El layout autenticado también entrega nombre y email iniciales a `DashboardHeader`, por lo que avatar y menú de salida no dependen de una recarga posterior.

### Apuesta diaria en Telegram

El workflow n8n `COMBINADA DEL DIA` se ejecuta diariamente a las 13:00 de
Madrid. Una sola llamada autenticada a `/api/cron/publish-combinada` reúne los
análisis y devuelve la selección final. `lib/telegram-daily-pick.js` exige 90%
por opción, admite únicamente goles, córners, tarjetas o remates a puerta,
prioriza una sola apuesta y, si hace falta, combina hasta tres partidos
distintos para una cuota total entre 1.50 y 2.00. El workflow no usa IA:
construye la URL de `/api/pick-image` y Telegram publica la tarjeta con escudos,
cuota, probabilidad y un único enlace a CF Análisis.

Una opción entra en recomendaciones generales cuando su frecuencia ponderada
real es de 80% o más y existe cuota real; la Apuesta del Día exige 90% o más y
aplica además su whitelist de mercados y rango de cuota. Las métricas fuera de
muestra son únicamente diagnósticas: nunca cambian el porcentaje ni bloquean
una frecuencia calculada. Los props de jugador siguen la misma regla cuando
existe historial y una cuota atribuible. El constructor distingue únicamente
entre recomendación estadística (≥80%) y dato estadístico seleccionable.
Todos los filtros, rankings y probabilidades conjuntas usan la frecuencia cruda;
web, PNG y mensaje de Telegram muestran como máximo 95% para no comunicar una
garantía. Un valor real de 99.75% se conserva como 99.75 internamente y se
presenta como 95%.

### Motor empírico de fútbol

`lib/model-engine.js` cuenta directamente hechos de `model.team_match_stats`.
Usa todos los partidos anteriores al kickoff sin mínimo ni máximo: una sola
muestra real sirve y cero muestras produce “sin dato”. Temporada actual e
histórico se calculan por separado; si ambos existen, `currentShare` siempre es
mayor a 0.50. Localía, nivel del rival, fase, H2H, árbitro y similitud del XI son
pesos sobre cumplimientos observados, nunca puntos añadidos/restados a una
probabilidad. H2H se deduplica por fixture; el árbitro solo pondera tarjetas,
faltas y rojas; el XI confirmado pondera alineaciones históricas reales.

Las medias descriptivas no se presentan como goles “esperados”: la interfaz
aclara que la media anotadora combinada y la frecuencia de superar una línea
son medidas diferentes. Los mercados de “menos de” usan el complemento exacto
del “más de”; no reciben ajustes artificiales y se recomiendan cuando su
frecuencia cruda alcanza el umbral del producto. El walk-forward de su
línea/dirección exacta permanece como diagnóstico auditable, no como bloqueo.

`scripts/train-football-empirical-engine.js` hace walk-forward nocturno sobre
1.200 partidos: 70% para escoger pesos y 30% cronológico intocable para aceptar
o rechazar el candidato y renovar el diagnóstico de cada familia exacta en las
bandas general, alta, diaria-90 y élite-95. Un candidato peor queda inactivo; el
campeón conserva producción y refresca sus métricas, que no actúan como gate.
`apps/cfanalisis-worker/src/jobs/futbol/retrain.js` ejecuta captura → ingesta →
perfiles → entrenamiento, falla si cualquier etapa queda incompleta y deja un
sello Redis que comprueba el watchdog.

`lib/football-api-client.cjs` es la única salida a API-Football para web,
workers y scripts activos. Reserva slots globales con Lua/Redis a un techo
conservador de 420 peticiones por minuto, reintenta con backoff y usa un fallback
local conservador si Redis cae. Distingue límite por minuto de cuota diaria: la
segunda no se reintenta y abre un cortacircuito Redis compartido hasta cinco
segundos después del reinicio oficial de cuota (00:00 UTC).
`scripts/audit-football-model-data.js` verifica de punta a punta
crudo, ledger, hechos, dimensiones, marcadores y contadores de jugador; código
de salida 2 significa una invariancia crítica rota.

### Motores empíricos de béisbol, baloncesto y fútbol americano

`lib/multisport-empirical-engine.js` comparte únicamente la implementación de
la fórmula de frecuencia observada; cada deporte usa su propio prefijo de
tablas, versión entrenada, diagnósticos, caché y colas. No existe lectura
cruzada entre `baseball`, `basketball` y `american_football`. Una muestra real
sirve y cero muestras devuelve “sin dato”. Temporada actual e histórico se
mantienen separados, la actualidad conserva más del 50% del peso y localía,
rival, competición, pitcher/quarterback y alineación solo ponderan hechos
observados semejantes. Cuotas, Poisson, isotónica, priors y shrinkage no alteran
el porcentaje. La frecuencia cruda se conserva para auditoría, filtros y
cálculos; la presentación se limita a 95% sin escribir ese límite de vuelta en
el motor. Una opción entra en recomendaciones por su propia frecuencia y cuota;
la validación cronológica mide el motor, pero jamás oculta o transforma el
resultado.

Las fuentes y namespaces de identificadores también están separados:

- NBA: feed/CDN oficial primero; si el servidor recibe bloqueo o timeout,
  `lib/nba-stats-api.js` cambia a API-NBA. API-Basketball queda para cuotas y
  como último respaldo de boxscores. ESPN completa calendario amplio y cuotas
  embebidas cuando están publicadas. El índice oficial de `nba.com/players`
  cruza nombres/equipos con el ID NBA y sus headshots CDN, incluso cuando el
  boxscore llega desde API-NBA. IDs y logos canónicos evitan duplicados al
  cambiar de fuente.
- NCAA baloncesto: calendario, logos, marcadores, boxscores, jugadores y cuotas
  publicadas mediante el feed deportivo de ESPN (grupo 50), con IDs aislados de
  NBA. No depende de la ventana de fechas de API-Sports.
- MLB/MiLB: MLB Stats oficial aporta calendarios de MLB, Triple-A, Double-A,
  High-A, Single-A y Rookie, además de live, boxscores y logos. El enriquecido
  de pitchers, alineaciones y props se reserva para MLB; API-Baseball se consulta
  solo para cuotas MLB y nunca se inventan cuotas de ligas menores.
- NFL: API-NFL aporta la ventana reciente cuando está disponible; ESPN garantiza
  el calendario amplio, IDs y logos canónicos, boxscores, jugadores y cuotas
  publicadas sin duplicar encuentros al cambiar de fuente.
- NCAA fútbol americano: ESPN aporta FBS (grupo 80) y FCS (grupo 81), con
  calendario, logos, marcador, boxscore, jugadores y cuotas cuando existen.

`scripts/train-multisport-empirical-engine.js` realiza selección cronológica
70/30 por deporte y guarda diagnósticos fuera de muestra sin recalibrar ni
bloquear el porcentaje. `scripts/backfill-multisport-history.js` carga una temporada y una
o varias competiciones por ejecución (`--competition`; MLB/MiLB usa rangos
oficiales de 45 días y NCAA consultas diarias concurrentes), y
`scripts/migrate-multisport-engines.sql` crea los almacenes
independientes; la migración requiere backup y debe ejecutarse antes de activar
las nuevas rutas en producción. Tenis permanece deshabilitado hasta aprobar una
fuente fiable.

Orden operativo de producción: aplicar la migración con backup, ejecutar por temporada
`npm run backfill:multisport -- <baseball|basketball|american_football> <año> [--competition=...]`,
entrenar con `npm run train:multisport` y solo entonces desplegar/reiniciar los
schedulers nuevos. Añadir `--dry` permite verificar cobertura sin escribir DB.

### Realtime

`apps/cfanalisis-worker` ingiere y publica actualizaciones. El cliente WebSocket
reenvía todos sus topics al abrir o reconectar. El dashboard usa esos eventos
como fuente primaria; si no recibe eventos durante 50 s, su watchdog consulta
solo el snapshot Redis mediante `GET /api/refresh-live`, con una única petición
en vuelo y separación mínima de 20 s. La revalidación completa de fixtures queda
como respaldo cada 5 min únicamente para hoy y con el WebSocket caído.

Las notificaciones Web Push de fútbol se agrupan por partido y tick. Solo
publican goles, goles anulados, córners, tarjetas, penaltis, remates, remates a
puerta y faltas; sustituciones, offsides y VAR genérico no generan avisos. Los
goles/tarjetas usan el evento oficial con jugador y asistencia. Un único detalle
`/fixtures?ids=...` por lote de hasta 20 partidos alimenta eventos, estadísticas
y jugadores cada tick: reemplaza las antiguas llamadas individuales de goleador
y `/fixtures/statistics` (36 partidos pasan de hasta 37 llamadas extra a 2;
400 simultáneos requieren 20). Remates y faltas comparan snapshots por jugador;
si una competición no ofrece cobertura individual no se inventa autor ni se
emite el evento. Sus snapshots viven en claves Redis
`live:playeractivity:{fixture}` separadas del payload del dashboard.

### Rendimiento del dashboard

La lista de partidos y la lista interna de “Apuesta del día” están virtualizadas:
solo se montan las filas próximas al viewport, independientemente de que existan
20, 100, 400 o más partidos. Una tarjeta analizada cerrada no monta mercados,
probabilidades ni jugadores; al abrirse, `ResizeObserver` mide solo esa fila sin
compensar el scroll. Las tarjetas están memoizadas y reciben handlers estables.

Baloncesto y fútbol americano usan el mismo armazón visual móvil de fútbol:
selector de fecha, competición/estado, pestañas Partidos/Combinada, tarjetas
expandibles y combinada flotante. Béisbol conserva sus mercados especializados,
pero comparte encabezado, controles, tabs, espaciado, color y comportamiento de
tarjetas. Los datos operativos de proveedor/cuota no aparecen en la experiencia
del cliente.

`GET /api/fixtures` usa `MGET` para documentos Redis, una consulta PostgreSQL
por lote para los `live_stats` ausentes y filtra análisis, cuotas, standings y
snapshots live a los IDs de la jornada antes de serializar la respuesta.

## Dependencias compartidas

- `app/globals.css`: sistema visual de Home, auth, planes, checkout y dashboard.
- `app/dashboard/components/DashboardHeader.js`: encabezado autenticado compartido.
- `app/dashboard/components/SportToggle.js`: selector y precarga de fútbol,
  MLB, NBA y NFL; tenis figura deshabilitado como pendiente.
- `app/dashboard/components/AnalysisFullModal.js`: carcasa compartida del análisis completo con scroll vertical nativo.
- `app/dashboard/utils/display-betting-text.js`: traducción exclusivamente
  visual de términos de mercados heredados; no modifica IDs ni payloads.
- `components/providers.js`: sesión global y sincronización de zona horaria.
- `lib/db.js`: pool y compatibilidad de queries; afecta casi toda la app.
- `lib/auth-pg.js` y `lib/auth-session.js`: cualquier cambio afecta login, layouts y APIs.
- `lib/stripe.js`: fuente única de IDs, precios, periodos y moneda base.
- `lib/payment-store.js`, `lib/payment-reconcile.js` y `lib/entitlements.js`: estado durable, recuperación y única regla de acceso.
- `lib/telegram-daily-pick.js`: whitelist y selector determinista de la publicación diaria de Telegram.
- `lib/model-engine.js`, `lib/model-to-scored.js` y
  `lib/model-probabilities.js`: frecuencia empírica, diagnóstico cronológico y contrato
  de probabilidades/combinadas. No añadir calibradores o priors al serving.
- `lib/football-api-client.cjs`: limitador distribuido y validación de respuestas
  de API-Football; toda nueva llamada al proveedor debe pasar por aquí.
- `lib/mercadopago.js`: API, firma, PSE, recurrencia, cancelación y fallback EUR→COP.
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
| App/worker | `NEXT_PUBLIC_APP_URL`, `WORKER_URL`, `CRON_SECRET`, secretos y URLs WS |
| Datos | `FOOTBALL_API_KEY`; `API_SPORTS_KEY` opcional (fallback a la anterior) y claves aislables `API_SPORTS_<PROVIDER>_KEY`/`API_NBA_KEY`/`API_BASKETBALL_KEY`/`API_BASEBALL_KEY`/`API_NFL_KEY`; presupuestos `API_SPORTS_<PROVIDER>_DAILY_BUDGET` |
| Email/push | `RESEND_API_KEY`, `FROM_EMAIL`, VAPID |

Nunca documentar valores. Las `NEXT_PUBLIC_*` requieren rebuild.

## Gotchas vivos

- 2026-07-29: el entorno local usa túneles al VPS; auth y pagos son producción real.
- 2026-08-01: nunca probar cobros locales con credenciales LIVE. QA llega al formulario o usa base/proveedor sandbox aislados.
- 2026-08-01: la migración `migrate-payment-reliability.sql` debe ejecutarse antes del build; incluye permisos explícitos para el rol `cfanalisis`.
- 2026-08-01: Stripe escucha facturas, suscripciones y compatibilidad de PaymentIntent legado. Añadir eventos con `scripts/configure-stripe-webhook.mjs` solo después de desplegar el handler.
- 2026-08-01: n8n ejecuta la versión publicada de cada workflow, no necesariamente el borrador visible en `workflow_entity`. Tras importar un cambio hay que publicarlo y reiniciar n8n; de lo contrario puede seguir activa una URL o conexión antigua.
- 2026-08-01: fútbol, MLB, NBA y NFL no usan calibración isotónica, shrinkage
  ni mínimos de muestra en serving. `baseball-calibrate` queda solo como cola
  de compatibilidad y responde `retired-empirical-engine`.
- 2026-08-01: no activar NBA/NFL ni el motor MLB nuevo antes de aplicar, con
  backup, `scripts/migrate-multisport-engines.sql`; el build no ejecuta DDL.
- 2026-08-01: los cuatro productos API-Sports mantienen cuota y cortacircuito
  Redis separados. Los productos multi-deporte reservan diez llamadas del plan
  gratuito y coordinan un máximo de diez solicitudes/minuto entre web y workers;
  un 429 temporal pausa el host, pero nunca abre el circuito de cuota diaria.
  Las cuotas deportivas nunca se usan como probabilidad del modelo.
- 2026-08-02: `FOOTBALL_CACHE_VERSION=20` y `MULTISPORT_CACHE_VERSION=12`
  invalidan análisis con el antiguo gate de validación o sin separación entre
  frecuencia cruda y valor visual. Las decisiones usan frecuencias ponderadas
  reales; el máximo 95% vive solo en la presentación y los diagnósticos nunca
  bloquean una recomendación.
- 2026-08-01: no liberar un intento pendiente por tiempo ni marcar terminal un cobro recurrente que MP pueda reintentar; primero cancelar el recurso remoto.
- 2026-07-29: el checkout automático requiere deduplicación persistente ante Strict Mode/Fast Refresh.
- 2026-07-29: solo el plan viaja por URL; el servidor vuelve a calcular precio, moneda y proveedor.
- 2026-07-29: `/planes` usa un escenario fijo; scroll, teclado y swipe cambian la tarjeta activa sin crear una lista vertical.
- 2026-07-29: el dashboard recibe identidad inicial desde su layout de servidor y precarga ambas rutas deportivas.
- 2026-07-29: el análisis completo de Fútbol y Baseball se abre en un modal
  compartido como documento vertical continuo. Todas las secciones permanecen
  en el flujo normal y el único contenedor desplazable usa el comportamiento
  nativo de rueda, trackpad, teclado e iOS/Android, sin controlador de gestos,
  escenas, progreso virtual ni scroll-snap.
- 2026-07-29: “Apuesta del día” permite que partido y recomendación envuelvan
  libremente y reserva una segunda fila para probabilidad/cuota. Los términos
  visibles `Over`, `Under` y `O/U` se traducen al renderizar; nunca renombrar
  las claves internas `over`/`under` porque alimentan el motor y las cuotas.
- 2026-07-29: `BrandLogoMedia` usa `/logo-metalizado-fast.webm` (512 px/15 fps,
  VP9 con plano alfa real) y `/logo-metalizado-alpha-fast.webp` como primer
  frame/fallback estático en WebKit/iOS. Un coordinador permite reproducir un
  solo logo a la vez.
- 2026-08-01: favicon e instalación PWA usan la identidad cuadrada CF en rutas
  versionadas (`/cf-favicon.ico`, `/cf-icon-{192,512}.png` y
  `/cf-apple-icon.png`) para evitar que Android/iOS conserven el icono anterior.
  El Service Worker usa `/cf-notification-badge.png`, monocromo y transparente,
  porque Android enmascara el badge de cada notificación.
- 2026-07-29: `analysis:{date}` es caché canónica global escrita únicamente
  por el worker; una respuesta de `/api/fixtures` jamás debe sobrescribirla con
  el subconjunto visible de una zona horaria. La ruta contrasta siempre
  `analyzed-ids:{date}` y días adyacentes para autorreparar caches parciales y
  cubrir partidos nocturnos que cambian de jornada entre Bogotá y Madrid.
- 2026-06: los nombres `supabaseAdmin`/`createSupabaseServerClient` son shims PG, no Supabase activo.
- El standalone necesita copiar `.env`, `public/` y enlazar `.next/static` como define el workflow.
