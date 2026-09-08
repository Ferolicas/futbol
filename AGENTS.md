# CF Análisis — instrucciones del proyecto

## Producto y producción

CF Análisis es una aplicación móvil de análisis de fútbol, béisbol, baloncesto y fútbol americano con acceso gratuito limitado y planes de suscripción. Producción: `https://cfanalisis.com` · VPS: `/apps/futbol` · PM2: `cfanalisis-web` · PostgreSQL: `cfanalisis`.

## Stack real

- Next.js 16.3 App Router, React 19.2 y JavaScript.
- PostgreSQL nativo mediante `pg` y el adaptador `lib/db.js`.
- Autenticación propia: bcrypt + `auth_sessions` + cookie JWT `cf_session`.
- Redis nativo mediante ioredis.
- Stripe fuera de Colombia; Mercado Pago para Colombia.
- Realtime y tareas pesadas en `apps/cfanalisis-worker`; fútbol publica deltas
  tipados por fixture mediante `packages/realtime-protocol`.
- Gestor del repositorio: npm (`package-lock.json`).

## Comandos

- Desarrollo: `npm run dev`
- Build obligatorio: `npm run build`
- Producción: push a `main` activa `.github/workflows/deploy.yml`. La web se compila en `.web-releases/` y se comprueba antes de cambiar PM2; nunca ejecutar build sobre la carpeta que está sirviendo producción.

Autorización permanente del propietario: toda solicitud de implementación incluye
commit y push a `main` al terminar y validar, lo que activa el deploy de producción.
No subir únicamente cuando el usuario indique expresamente “solo auditar”, “no
toques nada”, “no subir” o equivalente.

## Estructura esencial

- Páginas y API: `app/`
- Dashboard: `app/dashboard/`
- Autenticación: `lib/auth-pg.js`, `lib/auth-session.js`
- PostgreSQL: `lib/db.js`, adaptador legacy `lib/supabase.js`
- Pagos: `lib/stripe.js`, `lib/mercadopago.js`
- Worker: `apps/cfanalisis-worker/`
- Operación enterprise: `docs/enterprise/`, `ops/observability/`
- Migraciones: `scripts/migrate-*.sql`
- Mapa profundo: `docs/PROJECT-MAP.md`

## Reglas quirúrgicas

- La UI es móvil primero; escritorio adapta la versión móvil.
- No cambiar precios ni monedas fuera de `lib/stripe.js`.
- Nunca confiar en plan, precio o estado de pago enviados por el cliente.
- Free se filtra en servidor: una opción 60–70%, independiente de fiabilidad, solo con cuota real >=1.20 y casa identificada; esa opción visible aparece también en Apuesta del día y se puede añadir a la combinada. Antes del cierre, de las bloqueadas solo viaja la probabilidad y nunca sus etiquetas/IDs; después del final oficial se revelan nombre, cuota, casa y resultado.
- `Veredicto final` es un producto descriptivo aislado: no se recalibra ni se
  filtra por EV y sus opciones actuales no se modifican al cambiar el motor.
- Las recomendaciones del motor fallan cerradas: exigen corte prepartido,
  fiabilidad, validación temporal de su familia, cuota real y EV positivo. Las
  estadísticas calculadas siguen visibles aunque una opción no sea publicable.
- Nunca multiplicar mercados del mismo fixture como independientes. Solo una
  selección por fixture puede entrar en una combinada normal; un Bet Builder
  requiere probabilidad y cuota conjuntas oficiales.
- Cada pronóstico publicable debe escribirse antes en el ledger inmutable con
  versión, cutoff, hashes, evidencia y contexto; los resultados se anexan, no
  sobrescriben el pronóstico original.
- Un plan solo se activa después de confirmación del proveedor/webhook.
- No sustituir auth PG por Supabase: los nombres `supabase*` restantes son adaptadores de compatibilidad.
- El checkout automático transporta solo un ID de plan validado y una intención opaca; jamás el precio.
- `.env.local` contiene secretos LIVE y está fuera de Git.
- El navegador nunca recibe `WORKER_SECRET`: `/api/realtime/token` emite un JWT
  WS de cinco minutos y el worker autoriza cada topic por usuario/rol.
- El worker HTTP/WS escucha solo en `127.0.0.1`; Caddy es la única entrada
  pública. `/health` es mínimo y el detalle operativo exige `WORKER_SECRET`.
- Staging escucha solo en `127.0.0.1:3100`, usa `cfanalisis_staging` + Redis DB
  15 y jamás contiene credenciales LIVE ni datos personales de producción.
- Prometheus/Grafana/Alertmanager y exporters son nativos, loopback-only; no
  abrir sus puertos en Caddy o UFW.
- Antes de entregar cambios: `git diff --check` y `npm run build`.

## Gotchas

- En local, PostgreSQL y Redis del VPS requieren túneles a `127.0.0.1:16432` y `127.0.0.1:16379`.
- Stripe y Mercado Pago locales usan credenciales LIVE salvo que se reemplacen expresamente.
- React Strict Mode/Fast Refresh puede remontar efectos: toda apertura automática de checkout debe deduplicarse.
- Next.js 16 requiere Node.js >=20.9 y sus APIs de request (`cookies`, `params`,
  `searchParams`) son asíncronas en componentes y rutas de servidor.
- Caddy y el standalone dependen de que `public/` permanezca íntegro; no editar producción manualmente.
