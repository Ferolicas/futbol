import crypto from 'crypto';
import { supabaseAdmin } from '../../../../lib/supabase';
import { redisSet } from '../../../../lib/redis';
import { sendPasswordResetEmail } from '../../../../lib/zeptomail';

export async function POST(request) {
  try {
    const { email } = await request.json();
    if (!email?.trim()) {
      return Response.json({ error: 'Email requerido' }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();

    // Look up user in user_profiles
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('id, name, email')
      .eq('email', emailLower)
      .single();

    // Always return success to prevent email enumeration
    if (!profile) {
      return Response.json({ success: true });
    }

    // Generate secure token — store in Redis with 1-hour TTL
    const token = crypto.randomBytes(32).toString('hex');
    await redisSet(`pwd-reset:${token}`, { userId: profile.id, email: emailLower }, 3600);

    await sendPasswordResetEmail({
      to: emailLower,
      name: profile.name,
      token,
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ForgotPassword]', error.message);
    return Response.json({ error: 'Error al procesar la solicitud' }, { status: 500 });
  }
}
