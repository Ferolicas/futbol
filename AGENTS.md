# CF Análisis — instrucciones del proyecto

## Producto y producción

CF Análisis es una aplicación móvil de análisis de fútbol y béisbol con planes de suscripción. Producción: `https://cfanalisis.com` · VPS: `/apps/futbol` · PM2: `cfanalisis-web` · PostgreSQL: `cfanalisis`.

## Stack real

- Next.js 14 App Router, React 18 y JavaScript.
- PostgreSQL nativo mediante `pg` y el adaptador `lib/db.js`.
- Autenticación propia: bcrypt + `auth_sessions` + cookie JWT `cf_session`.
- Redis nativo mediante ioredis.
- Stripe fuera de Colombia; Mercado Pago para Colombia.
- Realtime y tareas pesadas en `apps/cfanalisis-worker`.
- Gestor del repositorio: npm (`package-lock.json`).

## Comandos

- Desarrollo: `npm run dev`
- Build obligatorio: `npm run build`
- Producción: push a `main` activa `.github/workflows/deploy.yml`.

No hacer commit, push ni deploy sin una instrucción explícita del usuario.

## Estructura esencial

- Páginas y API: `app/`
- Dashboard: `app/dashboard/`
- Autenticación: `lib/auth-pg.js`, `lib/auth-session.js`
- PostgreSQL: `lib/db.js`, adaptador legacy `lib/supabase.js`
- Pagos: `lib/stripe.js`, `lib/mercadopago.js`
- Worker: `apps/cfanalisis-worker/`
- Migraciones: `scripts/migrate-*.sql`
- Mapa profundo: `docs/PROJECT-MAP.md`

## Reglas quirúrgicas

- La UI es móvil primero; escritorio adapta la versión móvil.
- No cambiar precios ni monedas fuera de `lib/stripe.js`.
- Nunca confiar en plan, precio o estado de pago enviados por el cliente.
- Un plan solo se activa después de confirmación del proveedor/webhook.
- No sustituir auth PG por Supabase: los nombres `supabase*` restantes son adaptadores de compatibilidad.
- El checkout automático transporta solo un ID de plan validado y una intención opaca; jamás el precio.
- `.env.local` contiene secretos LIVE y está fuera de Git.
- Antes de entregar cambios: `git diff --check` y `npm run build`.

## Gotchas

- En local, PostgreSQL y Redis del VPS requieren túneles a `127.0.0.1:16432` y `127.0.0.1:16379`.
- Stripe y Mercado Pago locales usan credenciales LIVE salvo que se reemplacen expresamente.
- React Strict Mode/Fast Refresh puede remontar efectos: toda apertura automática de checkout debe deduplicarse.
- Caddy y el standalone dependen de que `public/` permanezca íntegro; no editar producción manualmente.
