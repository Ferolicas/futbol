import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM_EMAIL = process.env.FROM_EMAIL || 'CFanalisis <onboarding@resend.dev>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ferneyolicas@gmail.com';

export async function sendWelcomeEmail({ to, name, plan, password }) {
  if (!resend) {
    console.warn('Resend not configured, skipping welcome email');
    return null;
  }

  const PLAN_NAMES = {
    semanal: 'Plan Semanal',
    mensual: 'Plan Mensual',
    trimestral: 'Plan Trimestral',
    semestral: 'Plan Semestral',
    anual: 'Plan Anual',
    plataforma: 'Plan Plataforma', // legacy: usuarios antiguos
  };
  const planName = PLAN_NAMES[plan] || 'Plan';

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `Bienvenido a CFanalisis - ${planName}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Inter', Arial, sans-serif; background: #06060b; color: #f0f0ff; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
          .header { text-align: center; margin-bottom: 40px; }
          .logo { font-size: 28px; font-weight: 800; color: #00e676; }
          .card { background: #14141f; border: 1px solid rgba(255,255,255,0.06); border-radius: 16px; padding: 32px; margin-bottom: 24px; }
          h1 { color: #00e676; font-size: 24px; margin: 0 0 16px; }
          p { color: #8888aa; line-height: 1.6; margin: 0 0 12px; }
          .highlight { color: #f0f0ff; font-weight: 600; }
          .credentials { background: #1c1c2e; border-radius: 12px; padding: 20px; margin: 20px 0; }
          .credentials p { margin: 8px 0; }
          .label { color: #8888aa; font-size: 13px; }
          .value { color: #00e676; font-weight: 600; font-size: 16px; }
          .btn { display: inline-block; background: linear-gradient(135deg, #00e676, #00c853); color: #06060b; font-weight: 700; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-size: 16px; margin-top: 16px; }
          .footer { text-align: center; color: #555570; font-size: 12px; margin-top: 40px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">CFanalisis</div>
          </div>
          <div class="card">
            <h1>Bienvenido, ${name}!</h1>
            <p>Tu cuenta del <span class="highlight">${planName}</span> ha sido activada exitosamente.</p>
            <div class="credentials">
              <p><span class="label">Email:</span><br><span class="value">${to}</span></p>
              <p><span class="label">Contrasena:</span><br><span class="value">${password}</span></p>
            </div>
            <p>Guarda estas credenciales en un lugar seguro. Puedes cambiar tu contrasena desde tu perfil.</p>
            <a href="${process.env.NEXTAUTH_URL || 'https://cfanalisis.com'}/sign-in" class="btn">Ingresar a mi cuenta</a>
          </div>
          <div class="footer">
            <p>CFanalisis.com - Tu ventaja en cada apuesta</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });

  if (error) {
    console.error('Resend error:', error);
    throw new Error('Failed to send welcome email');
  }

  return data;
}

export async function sendTicketNotification({ ticketId, message, userEmail, userName }) {
  if (!resend) return null;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: ADMIN_EMAIL,
    subject: `Nuevo ticket ${ticketId} - CFanalisis`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Nuevo Ticket: ${ticketId}</h2>
        <p><strong>Usuario:</strong> ${userName} (${userEmail})</p>
        <p><strong>Mensaje:</strong></p>
        <blockquote style="border-left: 3px solid #00e676; padding-left: 12px; color: #555;">${message}</blockquote>
        <p><a href="${process.env.NEXTAUTH_URL || 'https://cfanalisis.com'}/admin/tickets">Ver en panel admin</a></p>
      </div>
    `,
  });

  if (error) console.error('Ticket notification error:', error);
  return data;
}

export async function sendChatNotification({ userName, userEmail, message }) {
  if (!resend) return null;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: ADMIN_EMAIL,
    subject: `Nuevo mensaje de ${userName} - CFanalisis Chat`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Nuevo mensaje de chat</h2>
        <p><strong>De:</strong> ${userName} (${userEmail})</p>
        <p><strong>Mensaje:</strong></p>
        <blockquote style="border-left: 3px solid #448aff; padding-left: 12px; color: #555;">${message}</blockquote>
        <p><a href="${process.env.NEXTAUTH_URL || 'https://cfanalisis.com'}/admin/chat">Responder en panel admin</a></p>
      </div>
    `,
  });

  if (error) console.error('Chat notification error:', error);
  return data;
}
