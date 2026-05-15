import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

/**
 * Middleware — solo refresca la sesion Supabase y bloquea rutas protegidas
 * sin sesion. Los checks de plan activo y rol admin se hacen en los layouts
 * (`app/dashboard/layout.js`, `app/admin/layout.js`) usando
 * `supabaseAdmin.from()` → VPS Postgres.
 *
 * Por que NO se hace el check de plan/rol aqui:
 *   El middleware corre en Edge Runtime (default Next.js). `lib/db.js` usa
 *   el driver `pg` con TCP sockets nativos, INCOMPATIBLE con Edge. Hacer
 *   fetch REST a la Supabase API (como antes) lee la tabla user_profiles
 *   de Supabase Postgres — pero esa tabla vive ahora en el VPS desde el
 *   commit b89c9b1. Resultado del codigo anterior: TODOS los usuarios,
 *   incluidos admins con plan activo, eran redirigidos a /planes porque
 *   el middleware veia profile=null. Bug critico.
 *
 *   Los layouts corren en Node runtime via supabaseAdmin (→ pgAdmin →
 *   VPS Postgres). Son el unico sitio fiable para leer user_profiles.
 */
export async function middleware(request) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session (efecto secundario importante: extiende las cookies)
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Rutas protegidas — si no hay sesion, manda a sign-in.
  // /dashboard, /admin, /ferney requieren user autenticado.
  // /planes se quita de aqui: un user sin plan necesita PODER visitarla
  // para pagar; antes estaba protegida y solo accesible tras redirect del
  // dashboard layout, lo que daba un loop confuso. El page de planes ya
  // pide auth si hace falta para mostrar precios personalizados.
  const protectedPaths = ['/dashboard', '/admin', '/ferney'];
  const needsAuth = protectedPaths.some(p => pathname.startsWith(p));

  if (needsAuth && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    return NextResponse.redirect(url);
  }

  // Nota: los checks de plan/role siguen, pero en los layouts:
  //   - app/dashboard/layout.js → redirige a /planes si no admin y sin plan
  //   - app/admin/layout.js     → redirige a /dashboard si no admin
  //   - app/sign-in/page.js     → redirige a /dashboard tras login OK
  // El check de "ya tienes sesion, no muestres /sign-in" lo decide cada
  // pagina segun convenga; no es responsabilidad del middleware.

  return supabaseResponse;
}

export const config = {
  // /planes se mantiene en el matcher para refrescar la cookie de sesion,
  // pero ya no se bloquea su acceso (necesario para el flujo de pago).
  matcher: ['/', '/sign-in', '/sign-up', '/dashboard/:path*', '/admin/:path*', '/ferney/:path*', '/ferney', '/planes/:path*'],
};
