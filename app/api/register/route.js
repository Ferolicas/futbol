import { supabaseAdmin } from '../../../lib/supabase';
import { sendWelcomeEmail } from '../../../lib/zeptomail';

export async function POST(request) {
  try {
    const { name, email, password, country, plan } = await request.json();

    if (!name || !email || !password) {
      return Response.json({ error: 'Nombre, email y contrasena son obligatorios' }, { status: 400 });
    }
    if (password.length < 6) {
      return Response.json({ error: 'La contrasena debe tener al menos 6 caracteres' }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();

    // Create Supabase Auth user (handles password hashing)
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: emailLower,
      password,
      email_confirm: true,
      user_metadata: { name: name.trim(), country: country || 'unknown' },
    });

    if (error) {
      if (error.message?.includes('already been registered') || error.message?.includes('already registered')) {
        return Response.json({ error: 'Este email ya esta registrado' }, { status: 409 });
      }
      console.error('[Register] createUser:', error.message);
      return Response.json({ error: 'Error al registrar usuario' }, { status: 500 });
    }

    const userId = data.user.id;

    // Create user profile
    await supabaseAdmin.from('user_profiles').upsert({
      id: userId,
      email: emailLower,
      name: name.trim(),
      country: country || 'unknown',
      role: 'user',
      plan: plan || null,
      subscription_status: 'pending',
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' }).catch(e => console.error('[Register] profile:', e.message));

    // Send welcome email (fire and forget)
    sendWelcomeEmail({ to: emailLower, name: name.trim(), password }).catch((e) =>
      console.error('[Register] Welcome email failed:', e.message)
    );

    return Response.json({ success: true, userId, message: 'Usuario registrado exitosamente' });
  } catch (error) {
    console.error('[Register] Error:', error.message, error.stack?.split('\n')[1]);
    return Response.json({ error: 'Error al registrar usuario', debug: error.message }, { status: 500 });
  }
}
