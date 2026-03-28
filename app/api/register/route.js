import bcrypt from 'bcryptjs';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';
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

    // Check if user already exists
    const existing = await queryFromSanity(
      `*[_type == "cfaUser" && email == $email][0]{ _id }`,
      { email: emailLower }
    );

    if (existing) {
      return Response.json({ error: 'Este email ya esta registrado' }, { status: 409 });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Generate unique user ID
    const userId = `cfaUser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Save user to Sanity
    await saveToSanity('cfaUser', userId.replace('cfaUser-', ''), {
      name: name.trim(),
      email: emailLower,
      password: hashedPassword,
      country: country || 'unknown',
      plan: plan || null,
      role: 'user',
      subscriptionStatus: 'pending',
      createdAt: new Date().toISOString(),
      analyzedMatches: [],
      hiddenMatches: [],
      combinadas: [],
    });

    // Send welcome email (fire and forget — don't block registration)
    sendWelcomeEmail({ to: emailLower, name: name.trim(), password }).catch((e) =>
      console.error('[Register] Welcome email failed:', e.message)
    );

    return Response.json({
      success: true,
      userId,
      message: 'Usuario registrado exitosamente',
    });
  } catch (error) {
    console.error('Registration error:', error);
    return Response.json({ error: 'Error al registrar usuario' }, { status: 500 });
  }
}
