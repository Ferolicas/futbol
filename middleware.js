import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

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

  // Refresh session
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Protected routes
  const protectedPaths = ['/dashboard', '/admin', '/ferney', '/planes'];
  const isProtected = protectedPaths.some(p => pathname.startsWith(p));

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    return NextResponse.redirect(url);
  }

  // Fetch profile using service role (bypasses RLS) via REST API
  const getProfile = async (userId) => {
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=subscription_status,role&limit=1`,
        {
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const rows = await res.json();
      return rows?.[0] || null;
    } catch {
      return null;
    }
  };

  // Landing / sign-in / sign-up — redirect to dashboard if already authenticated
  const authPages = ['/', '/sign-in', '/sign-up'];
  if (authPages.includes(pathname) && user) {
    const profile = await getProfile(user.id);
    const hasAccess = profile?.subscription_status === 'active' || ['admin', 'owner'].includes(profile?.role);
    if (hasAccess) {
      const url = request.nextUrl.clone();
      url.pathname = '/dashboard';
      return NextResponse.redirect(url);
    }
  }

  // Dashboard — require active subscription (admins bypass)
  if (pathname.startsWith('/dashboard') && user) {
    const profile = await getProfile(user.id);
    const hasAccess = profile?.subscription_status === 'active' || ['admin', 'owner'].includes(profile?.role);
    if (!hasAccess) {
      const url = request.nextUrl.clone();
      url.pathname = '/planes';
      return NextResponse.redirect(url);
    }
  }

  // Admin routes (and /ferney panel) — require admin or owner role
  if ((pathname.startsWith('/admin') || pathname.startsWith('/ferney')) && user) {
    const profile = await getProfile(user.id);
    if (!profile || !['admin', 'owner'].includes(profile.role)) {
      const url = request.nextUrl.clone();
      url.pathname = '/dashboard';
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/', '/sign-in', '/sign-up', '/dashboard/:path*', '/admin/:path*', '/ferney/:path*', '/ferney', '/planes/:path*'],
};
