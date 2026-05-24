/**
 * GET /api/auth-pg/verify-email?token=XXX
 *
 * Verifica el token y marca user.email_verified = TRUE.
 * Redirige a /dashboard?verified=1 en éxito.
 */

import { verifyEmail } from '../../../../lib/auth-pg';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');
  const result = await verifyEmail(token);
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://cfanalisis.com';
  if (result.error) {
    return NextResponse.redirect(`${base}/sign-in?verifyError=${encodeURIComponent(result.error.code)}`);
  }
  return NextResponse.redirect(`${base}/dashboard?verified=1`);
}
