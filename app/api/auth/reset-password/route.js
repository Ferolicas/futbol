import bcrypt from 'bcryptjs';
import { queryFromSanityFresh, patchSanity } from '../../../../lib/sanity';

export async function POST(request) {
  try {
    const { token, password } = await request.json();

    if (!token?.trim()) {
      return Response.json({ error: 'Token requerido' }, { status: 400 });
    }
    if (!password || password.length < 6) {
      return Response.json({ error: 'La contrasena debe tener al menos 6 caracteres' }, { status: 400 });
    }

    // Find user by reset token
    const user = await queryFromSanityFresh(
      `*[_type == "cfaUser" && resetToken == $token][0]{ _id, name, email, resetTokenExpiry }`,
      { token }
    );

    if (!user?._id) {
      return Response.json({ error: 'Enlace invalido o expirado' }, { status: 400 });
    }

    // Check expiry
    if (!user.resetTokenExpiry || new Date(user.resetTokenExpiry) < new Date()) {
      return Response.json({ error: 'El enlace ha expirado. Solicita uno nuevo.' }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const docId = user._id.replace('cfaUser-', '');

    // Set new password and clear the reset token
    await patchSanity('cfaUser', docId, {
      password: hashedPassword,
      resetToken: null,
      resetTokenExpiry: null,
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ResetPassword]', error.message);
    return Response.json({ error: 'Error al restablecer la contrasena' }, { status: 500 });
  }
}
