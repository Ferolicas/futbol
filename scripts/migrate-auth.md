# Fase 2.5 — Migración Supabase Auth → PG VPS

Switch de auth de Supabase a Postgres VPS nativo (bcryptjs + JWT cookies +
tabla `auth_sessions`). Permite eliminar el último servicio externo (Supabase)
y quedarse 100% en VPS.

## Estado actual

Después de los commits de Fase 2.5, el código tiene AMBOS backends:

- **Supabase Auth** (legacy, default) — `@supabase/ssr` con cookie `sb-*-auth-token`.
- **PG VPS auth** (nuevo) — `lib/auth-pg.js` + `lib/auth-session.js` con cookie `cf_session`.

El switch se controla con la env var `AUTH_PROVIDER`:

| Valor | Backend |
|-------|---------|
| (vacío o `supabase`) | Supabase Auth — comportamiento actual |
| `pg` | PG VPS nativo (nuevo) |

## Plan de migración (orden importa)

### 1. Aplicar schema SQL (idempotente)

```bash
PGPASSWORD='Pump0517*' psql -h 127.0.0.1 -p 6432 -U cfanalisis -d cfanalisis \
  -f /apps/futbol/scripts/migrate-auth.sql
```

Esto crea:
- `users` (id, email, password_hash, email_verified, tokens, locked_until)
- `auth_sessions` (id, user_id, expires_at, last_seen, user_agent, ip)
- Trigger `users_updated_at`
- View `v_user_full` (users + user_profiles)

### 2. Copiar usuarios existentes de Supabase a PG

```bash
cd /apps/futbol
node --env-file=.env scripts/migrate-supabase-users-to-pg.js
```

El script:
- Lista todos los users de Supabase Auth (paginado)
- Inserta en `users` con el MISMO UUID que Supabase usaba (preserva
  user_profiles.id que ya estaba enlazado a Supabase Auth)
- `password_hash` queda NULL — los users tienen que usar "olvidé contraseña"
  la primera vez
- `email_verified` se copia de `email_confirmed_at` de Supabase

### 3. Generar JWT secret

```bash
# En el .env de Next.js (/apps/futbol/.env)
echo "AUTH_JWT_SECRET=$(openssl rand -base64 32)" >> /apps/futbol/.env
```

Mínimo 32 caracteres. Si no se pone, lib/auth-session.js lanza error.

### 4. Activar PG auth con feature flag

```bash
echo "AUTH_PROVIDER=pg" >> /apps/futbol/.env
pm2 reload cfanalisis-web --update-env
```

A partir de aquí:
- `createSupabaseServerClient().auth.getUser()` ya usa el shim de PG.
- Login/signup nuevos van a `/api/auth-pg/*`.
- Los users migrados pueden hacer login solo si:
  - Ya hicieron "olvidé contraseña" Y resetearon, O
  - El admin (tú) les inyectó un password_hash manualmente.

### 5. Reset tu propia cuenta

```bash
curl -X POST https://cfanalisis.com/api/auth-pg/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"ferneyolicas@gmail.com"}'
```

Mira el log de la app (`pm2 logs cfanalisis-web`) — verás:
```
[auth-pg] password reset token created for user c774b579-... (TODO wire email send)
```

Para enviar el email de verdad, configurar ZeptoMail en `/api/auth-pg/forgot-password/route.js`
(hay un TODO marcado). Mientras tanto, el token plain queda en logs.

Alternativa quick — setear tu password directo en DB:
```bash
# Generar hash bcrypt de tu nueva password en Node:
node -e "console.log(require('bcryptjs').hashSync('MiNuevaPassword123', 10))"

# Y luego en SQL:
PGPASSWORD='Pump0517*' psql -h 127.0.0.1 -p 6432 -U cfanalisis -d cfanalisis -c "
UPDATE users SET password_hash = '\$2a\$10\$...' WHERE email = 'ferneyolicas@gmail.com';
"
```

### 6. Migrar los sign-in/sign-up pages del frontend

Las páginas `app/sign-in/[[...sign-in]]/page.js` y similares usan probablemente
el cliente Supabase via `lib/supabase.js` (supabaseAnon). Después del switch
a PG, hay que cambiar:

```js
// ANTES (supabase)
import { supabaseAnon } from '@/lib/supabase';
const { error } = await supabaseAnon.auth.signInWithPassword({ email, password });

// DESPUÉS (PG)
const r = await fetch('/api/auth-pg/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const data = await r.json();
if (!r.ok) throw new Error(data.error?.message || 'Login failed');
```

Esto se hace en una segunda iteración una vez confirmemos que el flow del
backend funciona.

### 7. Cleanup cron (opcional)

Para limpiar sesiones expiradas + tokens viejos diariamente, añadir a crontab:

```cron
0 5 * * * curl -s -X POST https://cfanalisis.com/api/admin/auth-cleanup -H "Authorization: Bearer $CRON_SECRET"
```

(El endpoint `/api/admin/auth-cleanup` no está creado todavía — TODO al hacer
el switch final.)

### 8. Apagar Supabase

Tras 1-2 semanas de uso estable con `AUTH_PROVIDER=pg`:

```bash
# Cancelar la suscripción Supabase desde el dashboard.
# Limpiar el .env:
sed -i '/^NEXT_PUBLIC_SUPABASE_URL=/d'     /apps/futbol/.env
sed -i '/^NEXT_PUBLIC_SUPABASE_ANON_KEY=/d' /apps/futbol/.env
sed -i '/^SUPABASE_SERVICE_ROLE_KEY=/d'     /apps/futbol/.env

# Borrar @supabase/* del package.json (cuidado: supabaseAdmin proxy en lib/supabase.js
# todavía importa createClient para .auth.admin.*. Reemplazar antes de quitar la dep).
```

Despues de esto, cero externos de Supabase. El último mes de uso queda
trackeable en `auth_sessions.last_seen`.

## Endpoints nuevos

| Ruta | Método | Función |
|------|--------|---------|
| `/api/auth-pg/signup` | POST | Crear cuenta nueva |
| `/api/auth-pg/login` | POST | Login con email + password |
| `/api/auth-pg/logout` | POST | Cerrar sesión + borrar cookie |
| `/api/auth-pg/me` | GET | Devolver user actual |
| `/api/auth-pg/forgot-password` | POST | Generar reset token |
| `/api/auth-pg/reset-password` | POST | Consumir token + nuevo password |
| `/api/auth-pg/verify-email?token=` | GET | Verifica email |

## Esquema de cookie

Cuando `AUTH_PROVIDER=pg`:
- Cookie name: `cf_session`
- httpOnly: yes
- secure: yes (prod) / no (dev)
- sameSite: lax
- maxAge: 30 días
- Contenido: JWT firmado con HS256 conteniendo `{ uid, sid, exp, iat }`

Validación en cada request:
1. Verificar firma JWT (rápido, sin DB)
2. Verificar `sid` existe en `auth_sessions` con `expires_at > NOW()`
3. Bump `auth_sessions.last_seen` (async, fire-and-forget)

Revocación instantánea: borrar fila de `auth_sessions` → JWT queda inválido
en el próximo request.
