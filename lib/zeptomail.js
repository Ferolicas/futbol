/**
 * ZeptoMail email client — sends transactional emails from info@cfanalisis.com
 */

const ZEPTOMAIL_URL = 'https://api.zeptomail.com/v1.1/email';
const APP_URL = process.env.NEXTAUTH_URL || 'https://cfanalisis.com';

async function sendEmail({ to, toName, subject, html }) {
  const apiKey = process.env.ZEPTOMAIL_API_KEY;
  if (!apiKey) {
    console.warn('[ZeptoMail] ZEPTOMAIL_API_KEY not configured');
    return null;
  }

  const res = await fetch(ZEPTOMAIL_URL, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      from: { address: 'info@cfanalisis.com', name: 'CF Analisis' },
      to: [{ email_address: { address: to, name: toName || to } }],
      subject,
      htmlbody: html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[ZeptoMail] Error:', err);
    throw new Error(`ZeptoMail error ${res.status}: ${err}`);
  }

  return res.json();
}

// ─── BASE TEMPLATE ────────────────────────────────────────────────────────────

function baseTemplate(content) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CF Analisis</title>
</head>
<body style="margin:0;padding:0;background:#06060b;font-family:'Inter',Arial,sans-serif;color:#f0f0ff;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#06060b;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <!-- HEADER -->
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <span style="font-size:26px;font-weight:800;color:#00e676;letter-spacing:-1px;">CF Analisis</span>
            </td>
          </tr>
          <!-- CONTENT -->
          <tr>
            <td style="background:#14141f;border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:36px;">
              ${content}
            </td>
          </tr>
          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding-top:28px;color:#444460;font-size:12px;line-height:1.6;">
              CFanalisis.com — Tu ventaja en cada apuesta<br>
              Si no solicitaste este correo, puedes ignorarlo.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── WELCOME EMAIL ─────────────────────────────────────────────────────────────

export async function sendWelcomeEmail({ to, name, password }) {
  const html = baseTemplate(`
    <h1 style="color:#00e676;font-size:22px;margin:0 0 16px;">Bienvenido a CF Analisis, ${name}!</h1>
    <p style="color:#8888aa;line-height:1.7;margin:0 0 20px;">
      Tu cuenta ha sido creada exitosamente. Aqui estan tus credenciales de acceso:
    </p>
    <div style="background:#1c1c2e;border-radius:12px;padding:20px;margin:0 0 24px;">
      <p style="margin:0 0 12px;">
        <span style="color:#8888aa;font-size:12px;display:block;margin-bottom:4px;">CORREO ELECTRONICO</span>
        <span style="color:#f0f0ff;font-size:15px;font-weight:600;">${to}</span>
      </p>
      <p style="margin:0;">
        <span style="color:#8888aa;font-size:12px;display:block;margin-bottom:4px;">CONTRASENA</span>
        <span style="color:#00e676;font-size:15px;font-weight:600;">${password}</span>
      </p>
    </div>
    <p style="color:#8888aa;font-size:13px;line-height:1.6;margin:0 0 24px;">
      Guarda estas credenciales en un lugar seguro. Para completar tu acceso, selecciona un plan de suscripcion.
    </p>
    <a href="${APP_URL}/sign-in" style="display:inline-block;background:linear-gradient(135deg,#00e676,#00c853);color:#06060b;font-weight:700;padding:14px 32px;border-radius:12px;text-decoration:none;font-size:15px;">
      Ingresar a mi cuenta
    </a>
  `);

  return sendEmail({
    to,
    toName: name,
    subject: 'Bienvenido a CF Analisis — Tus credenciales de acceso',
    html,
  });
}

// ─── PASSWORD RESET EMAIL ──────────────────────────────────────────────────────

export async function sendPasswordResetEmail({ to, name, token }) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  const html = baseTemplate(`
    <h1 style="color:#f0f0ff;font-size:22px;margin:0 0 16px;">Restablecer contrasena</h1>
    <p style="color:#8888aa;line-height:1.7;margin:0 0 24px;">
      Hola <strong style="color:#f0f0ff;">${name || to}</strong>, recibimos una solicitud para restablecer
      la contrasena de tu cuenta. Haz clic en el boton para continuar:
    </p>
    <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#00e676,#00c853);color:#06060b;font-weight:700;padding:14px 32px;border-radius:12px;text-decoration:none;font-size:15px;margin-bottom:24px;">
      Restablecer mi contrasena
    </a>
    <p style="color:#8888aa;font-size:13px;line-height:1.6;margin:0 0 12px;">
      O copia este enlace en tu navegador:
    </p>
    <p style="background:#1c1c2e;border-radius:8px;padding:12px;word-break:break-all;font-size:12px;color:#00e676;margin:0 0 24px;">
      ${resetUrl}
    </p>
    <p style="color:#555570;font-size:12px;line-height:1.6;margin:0;border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;">
      Este enlace expira en <strong style="color:#f0f0ff;">1 hora</strong>.
      Si no solicitaste restablecer tu contrasena, ignora este correo.
    </p>
  `);

  return sendEmail({
    to,
    toName: name,
    subject: 'Restablecer contrasena — CF Analisis',
    html,
  });
}
