# CLAUDE.md — Instrucciones de Sistema para Claude Code

> **IMPORTANTE:** Este archivo define el comportamiento obligatorio de Claude en este workspace. Estas instrucciones tienen prioridad sobre cualquier comportamiento por defecto. Leer completo antes de ejecutar cualquier tarea.

---

## 0. PROTOCOLO DE INICIO — SIEMPRE EJECUTAR PRIMERO

Antes de responder cualquier tarea, ejecutar en este orden:

1. **`memory` MCP** → Cargar contexto del proyecto activo y preferencias del usuario
2. **`filesystem` MCP** → Ubicar la raíz del proyecto actual (no explorar desde cero, usar rutas conocidas)
3. **`serena` MCP** → Indexar símbolos, clases y funciones del proyecto para navegación directa
4. **`sequential-thinking` MCP** → Activar razonamiento paso a paso antes de cualquier decisión de arquitectura o código

Solo después de estos 4 pasos, responder o ejecutar.

---

## 1. MAPA DE MCPs Y CLIs — CUÁNDO USAR CADA UNO

### MCPs

| MCP | Cuándo usarlo SIEMPRE |
|---|---|
| **memory** | Al inicio de cada sesión. Guardar decisiones de arquitectura, patrones establecidos, rutas de proyecto, convenciones del cliente |
| **filesystem** | Para leer, escribir, mover o verificar archivos del proyecto. Nunca asumir rutas sin verificar |
| **serena** | Para navegar código existente: buscar componentes, funciones, tipos, imports. Evita reescribir lo que ya existe |
| **context7** | Para consultar documentación oficial actualizada de cualquier librería (Next.js, Supabase, NextAuth, Zod, etc.) antes de implementar |
| **sequential-thinking** | Para tareas complejas: diseño de BD, auth flows, arquitectura de API, refactors grandes |
| **shadcn** | Para cualquier componente UI. Consultar disponibilidad y variantes antes de crear componentes custom |
| **github** | Para crear PRs, revisar issues, pushear branches, gestionar releases |
| **playwright** | Para testing E2E. Toda funcionalidad crítica de producción debe tener test |

### CLIs

| CLI | Uso obligatorio |
|---|---|
| **git** | Todo cambio va a commit. Mensajes en formato `feat:`, `fix:`, `chore:`, `refactor:`. Nunca trabajar en `main` directamente |
| **vercel** | Deploy, variables de entorno en producción, preview deployments. Nunca configurar producción manualmente |
| **uv** | Gestión de entornos Python si aplica. Siempre usar `uv` en lugar de `pip` directo |

---

## 2. REGLAS DE SEGURIDAD — OBLIGATORIAS SIN EXCEPCIÓN

### 2.1 Sanity — Reglas de Seguridad

- **Nunca** exponer el `SANITY_API_TOKEN` con permisos de escritura en el cliente
- Queries de escritura (mutaciones) **siempre desde servidor** (API Routes o Server Actions)
- Queries de lectura pública: usar token de solo lectura o sin token si el dataset es público
- CORS en Sanity Studio: configurar solo los dominios autorizados del proyecto en `sanity.io/manage`
- Verificar con `context7` MCP la documentación actualizada de Sanity antes de implementar queries o schemas nuevos
- **Nunca** usar `perspective: 'previewDrafts'` en producción sin verificar sesión de usuario autorizado

### 2.2 Middleware de Protección de Rutas

Archivo obligatorio: `middleware.ts` en la raíz del proyecto Next.js.

```typescript
// middleware.ts — SIEMPRE presente en proyectos Next.js
import { withAuth } from "next-auth/middleware"
import { NextResponse } from "next/server"

export default withAuth(
  function middleware(req) {
    // Lógica de autorización por rol si aplica
    return NextResponse.next()
  },
  {
    callbacks: {
      authorized: ({ token }) => !!token,
    },
  }
)

export const config = {
  matcher: ["/dashboard/:path*", "/api/protected/:path*"],
}
```

### 2.3 Headers de Seguridad HTTP

Siempre presentes en `next.config.js`:

```javascript
const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload"
  },
]
```

### 2.4 Variables de Entorno

- `.env.local` → **NUNCA en git**. Verificar `.gitignore` antes de cualquier commit
- Variables públicas: solo `NEXT_PUBLIC_` cuando sea estrictamente necesario en cliente
- Variables de servidor: sin prefijo, nunca expuestas al bundle del cliente
- En Vercel: usar `vercel env add` o dashboard para producción, nunca hardcodear
- Plantilla pública obligatoria: `.env.example` con keys pero sin valores reales

### 2.5 Rate Limiting en API Routes

Obligatorio en toda ruta que reciba input del usuario:

```typescript
import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "10 s"),
})

// En cada API Route:
const identifier = req.headers.get("x-forwarded-for") ?? "anonymous"
const { success } = await ratelimit.limit(identifier)
if (!success) return new Response("Too Many Requests", { status: 429 })
```

### 2.6 Validación con Zod

**Toda entrada de usuario debe ser validada con Zod antes de procesarse:**

```typescript
import { z } from "zod"

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
})

const result = schema.safeParse(body)
if (!result.success) {
  return Response.json({ error: result.error.flatten() }, { status: 400 })
}
```

- Nunca confiar en datos del cliente sin validar
- Schemas de Zod reutilizables en `/lib/validations/`

### 2.7 Autenticación con NextAuth

- Toda lógica de auth en servidor (`/app/api/auth/[...nextauth]/`)
- Sesiones con JWT o Database Sessions — nunca lógica de sesión en cliente
- Callbacks de `session` y `jwt` en el servidor siempre
- Usar `getServerSession()` en Server Components, nunca `useSession()` para datos sensibles

---

## 3. PRINCIPIO FUNDAMENTAL — SERVIDOR SIEMPRE

> **Estos proyectos son de producción real para clientes. No son proyectos de hobby. No son para uso local.**

### Reglas absolutas de Server-Side:

- **Passwords y hashes**: siempre en servidor con `bcrypt` o `argon2`. Nunca en cliente
- **Tokens y secrets**: siempre en variables de entorno de servidor, nunca en el cliente
- **Queries a BD**: siempre desde Server Components, Server Actions o API Routes
- **Lógica de negocio crítica**: siempre en servidor
- **Emails transaccionales**: desde servidor (Resend, SendGrid) con templates en servidor
- **Uploads de archivos**: validar tipo y tamaño en servidor, nunca confiar en validación del cliente
- **Pagos**: lógica siempre en servidor (Stripe webhooks verificados con firma)

### Lo que NUNCA va en el cliente:

```
❌ fetch() a BD directamente desde componentes cliente
❌ Lógica de autorización en el frontend
❌ API keys aunque sean "solo de lectura"
❌ Validación como única capa de seguridad
❌ localStorage para datos sensibles de sesión
```

---

## 4. STACK Y CONVENCIONES DE PROYECTO

### Stack base

- **Framework**: Next.js (App Router) con TypeScript estricto
- **CMS / Backend de contenido**: Sanity
- **Auth**: NextAuth.js
- **UI**: shadcn/ui + Tailwind CSS
- **Deploy**: Vercel
- **Validación**: Zod
- **Queries de contenido**: Sanity client con GROQ (siempre server-side)

### Estructura de carpetas obligatoria

```
/app
  /api          → API Routes (solo lógica servidor)
  /(auth)       → Rutas protegidas agrupadas
  /layout.tsx   → Con providers y metadata global
/components
  /ui           → Componentes shadcn (no modificar directamente)
  /shared       → Componentes reutilizables
/lib
  /sanity       → Client, schemas, queries GROQ (fetch siempre server-side)
  /validations  → Schemas Zod
  /utils        → Helpers puros
/types          → Tipos globales TypeScript
middleware.ts   → En raíz, siempre presente
```

### TypeScript

- `strict: true` siempre en `tsconfig.json`
- Nunca usar `any`. Si es necesario, usar `unknown` y tipar correctamente
- Tipos de Sanity generados con `npx sanity@latest typegen generate`

---

## 5. FLUJO DE TRABAJO GIT

```bash
# Branches
main          → producción (protegida, nunca push directo)
develop       → staging
feat/nombre   → features nuevas
fix/nombre    → correcciones

# Commit antes de cualquier cambio significativo
git add .
git commit -m "feat: descripción clara del cambio"

# Deploy a producción siempre via Vercel CLI o GitHub Actions
vercel --prod  # nunca deploy manual de archivos
```

---

## 6. COMPORTAMIENTO DE CLAUDE EN ESTE WORKSPACE

### Al recibir cualquier tarea:

1. Usar **`memory` MCP** → recuperar contexto del proyecto
2. Usar **`serena` MCP** → localizar archivos relevantes sin explorar manualmente
3. Usar **`context7` MCP** → verificar documentación si hay duda sobre una API
4. Usar **`sequential-thinking` MCP** → planificar antes de ejecutar si la tarea es compleja
5. Ejecutar con `filesystem` MCP y CLIs correspondientes
6. Guardar decisiones importantes en **`memory` MCP**

### Al crear componentes UI:

1. Consultar **`shadcn` MCP** primero → ¿existe el componente?
2. Si existe: instalar con `npx shadcn@latest add [componente]`
3. Si no existe: crear en `/components/shared/` con Tailwind
4. Nunca duplicar componentes que ya existen en el proyecto (verificar con `serena`)

### Al hacer testing:

1. Usar **`playwright` MCP** para E2E en flujos críticos: auth, pagos, formularios
2. Toda feature nueva de producción debe tener al menos un test E2E

### Al hacer deploy:

1. Verificar variables de entorno con `vercel env ls`
2. Preview deploy primero: `vercel`
3. Producción solo cuando preview está validado: `vercel --prod`
4. Commit y push a GitHub antes del deploy final

---

## 7. PERFORMANCE Y USO MUNDIAL

- **Imágenes**: siempre `next/image` con `sizes` apropiado para responsive
- **Fonts**: `next/font` con `display: swap`
- **Internacionalización**: usar `next-intl` si el proyecto es multiidioma
- **Edge Runtime**: considerar para middleware y rutas de alta demanda
- **Cache**: usar `revalidate` y `unstable_cache` correctamente, nunca cache infinito en datos dinámicos
- **Error boundaries**: siempre presentes en rutas principales
- **Loading states**: siempre usar `loading.tsx` en App Router
- **Metadata**: SEO completo en `layout.tsx` y `page.tsx` con `generateMetadata`

---

*Este archivo es la fuente de verdad del workspace. Actualizar en `memory` MCP cuando cambien convenciones del proyecto.*
