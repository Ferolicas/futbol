import crypto from 'crypto';
import { queryFromSanityFresh, patchSanity } from '../../../../lib/sanity';
import { sendPasswordResetEmail } from '../../../../lib/zeptomail';

export async function POST(request) {
  try {
    const { email } = await request.json();
    if (!email?.trim()) {
      return Response.json({ error: 'Email requerido' }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();

    const user = await queryFromSanityFresh(
      `*[_type == "cfaUser" && email == $email][0]{ _id, name, email }`,
      { email: emailLower }
    );

    // Always return success even if user not found (prevents email enumeration)
    if (!user?._id) {
      return Response.json({ success: true });
    }

    // Generate secure random token (expires in 1 hour)
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // Patch only the reset token fields — does not overwrite password or other data
    const docId = user._id.replace('cfaUser-', '');
    await patchSanity('cfaUser', docId, {
      resetToken: token,
      resetTokenExpiry: expiry,
    });

    await sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      token,
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error('[ForgotPassword]', error.message);
    return Response.json({ error: 'Error al procesar la solicitud' }, { status: 500 });
  }
}
