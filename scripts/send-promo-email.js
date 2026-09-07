/**
 * Promo email blast — sends a sales-focused email with all 5 plans
 * to every user in user_profiles (active or pending).
 *
 * Usage:
 *   node scripts/send-promo-email.js --test ferneyolicas@gmail.com   # send 1 to test
 *   node scripts/send-promo-email.js --all                            # blast to everyone
 *   node scripts/send-promo-email.js --all --dry                      # list recipients, no send
 *
 * Requiere ZEPTOMAIL_API_KEY y DATABASE_URL en el entorno. Para cargar un
 * archivo de entorno hazlo explícitamente con `node --env-file=.env.local`.
 */

const { Pool } = require('pg');

const ZEPTOMAIL_API_KEY = process.env.ZEPTOMAIL_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!ZEPTOMAIL_API_KEY || !DATABASE_URL) {
  console.error('Missing required environment variables:');
  console.error('  ZEPTOMAIL_API_KEY:', ZEPTOMAIL_API_KEY ? 'OK' : 'MISSING');
  console.error('  DATABASE_URL:', DATABASE_URL ? 'OK' : 'MISSING');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 2,
});

// ─── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const TEST_IDX = args.indexOf('--test');
const ALL = args.includes('--all');
const DRY = args.includes('--dry');
const TEST_EMAIL = TEST_IDX >= 0 ? args[TEST_IDX + 1] : null;

if (TEST_IDX >= 0 && (!TEST_EMAIL || TEST_EMAIL.startsWith('--'))) {
  console.error('--test requires an email argument. Example:');
  console.error('  node scripts/send-promo-email.js --test ferneyolicas@gmail.com');
  process.exit(1);
}

if (!ALL && !TEST_EMAIL) {
  console.error('Usage:');
  console.error('  node scripts/send-promo-email.js --test <email>');
  console.error('  node scripts/send-promo-email.js --all [--dry]');
  process.exit(1);
}

// ─── plan data ────────────────────────────────────────────────────────────────
const APP_URL = 'https://cfanalisis.com';
const CTA_URL = `${APP_URL}/sign-in`;

const PLANS = [
  { id: 'semanal',    name: 'Semanal',    amount: 7,   currency: 'USD', symbol: '$', per: '/ semana',  badge: null,           highlight: false, original: null, discountTag: null },
  { id: 'mensual',    name: 'Mensual',    amount: 15,  currency: 'USD', symbol: '$', per: '/ mes',     badge: 'POPULAR',      highlight: true,  original: null, discountTag: null },
  { id: 'trimestral', name: 'Trimestral', amount: 35,  currency: 'USD', symbol: '$', per: '/ 3 meses', badge: null,           highlight: false, original: null, discountTag: null },
  { id: 'semestral',  name: 'Semestral',  amount: 80,  currency: 'USD', symbol: '$', per: '/ 6 meses', badge: 'MEJOR PRECIO', highlight: false, original: null, discountTag: null },
  { id: 'anual',      name: 'Anual',      amount: 100, currency: 'EUR', symbol: '€', per: '/ año',     badge: 'VIP',          highlight: false, original: 120,  discountTag: 'AHORRA 20€ — PRECIO DEFINITIVO' },
];

// ─── email template ───────────────────────────────────────────────────────────
function buildPlanCard(plan) {
  const accent = plan.highlight ? '#00e676' : (plan.badge === 'VIP' ? '#ffd54f' : 'rgba(255,255,255,0.06)');
  const badgeBg = plan.highlight ? '#00e676' : plan.badge === 'VIP' ? '#ffd54f' : '#7c4dff';
  const badgeColor = plan.badge === 'VIP' || plan.highlight ? '#06060b' : '#fff';
  const badgeHtml = plan.badge
    ? `<div style="display:inline-block;background:${badgeBg};color:${badgeColor};font-size:10px;font-weight:800;letter-spacing:1px;padding:4px 10px;border-radius:999px;margin-bottom:10px;">${plan.badge}</div>`
    : '';

  const originalHtml = plan.original
    ? `<span style="color:#7a7a99;font-size:16px;font-weight:600;text-decoration:line-through;margin-right:8px;">${plan.symbol}${plan.original}</span>`
    : '';

  const discountTagHtml = plan.discountTag
    ? `<div style="display:inline-block;background:rgba(255,82,82,0.12);color:#ff5252;border:1px solid rgba(255,82,82,0.3);font-size:11px;font-weight:800;letter-spacing:0.5px;padding:5px 10px;border-radius:6px;margin:0 0 12px;">${plan.discountTag}</div>`
    : '';

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1c1c2e;border:1px solid ${accent};border-radius:14px;margin:0 0 14px;">
      <tr>
        <td style="padding:20px 22px;">
          ${badgeHtml}
          <div style="color:#f0f0ff;font-size:18px;font-weight:700;margin:0 0 4px;">Plan ${plan.name}</div>
          <div style="color:#8888aa;font-size:13px;line-height:1.5;margin:0 0 14px;">
            Acceso completo a la plataforma de analisis
          </div>
          ${discountTagHtml}
          <div style="margin:0 0 16px;">
            ${originalHtml}<span style="color:#00e676;font-size:28px;font-weight:800;letter-spacing:-0.5px;">${plan.symbol}${plan.amount}</span>
            <span style="color:#8888aa;font-size:13px;margin-left:6px;">${plan.currency} ${plan.per}</span>
          </div>
          <a href="${CTA_URL}" style="display:block;background:linear-gradient(135deg,#00e676,#00c853);color:#06060b;font-weight:800;padding:13px 0;border-radius:10px;text-decoration:none;font-size:14px;text-align:center;letter-spacing:0.3px;">
            Activar Plan ${plan.name}
          </a>
        </td>
      </tr>
    </table>
  `;
}

function buildHtml(name) {
  const greetRaw = name && name.trim() ? name.trim().split(' ')[0] : 'apostador';
  const greet = String(greetRaw).slice(0, 80).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const plansHtml = PLANS.map(buildPlanCard).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CF Analisis — Activa tu plan</title>
</head>
<body style="margin:0;padding:0;background:#06060b;font-family:'Inter',Arial,sans-serif;color:#f0f0ff;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#06060b;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <span style="font-size:28px;font-weight:800;color:#00e676;letter-spacing:-1px;">CF Analisis</span>
            </td>
          </tr>

          <tr>
            <td style="background:#14141f;border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:36px 32px;">

              <h1 style="color:#f0f0ff;font-size:26px;line-height:1.3;margin:0 0 14px;font-weight:800;">
                Hola ${greet}, deja de apostar a ciegas.
              </h1>

              <p style="color:#c0c0d0;font-size:15px;line-height:1.7;margin:0 0 18px;">
                Cada dia, miles de partidos. Cada partido, miles de cuotas.
                <strong style="color:#00e676;">Solo unas pocas tienen valor real.</strong>
                CF Analisis las encuentra por ti — con datos, modelos y calibracion profesional.
              </p>

              <p style="color:#c0c0d0;font-size:15px;line-height:1.7;margin:0 0 24px;">
                Tu cuenta ya esta creada. Solo te falta activar tu plan para acceder a:
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="padding:6px 0;color:#f0f0ff;font-size:14px;line-height:1.6;">
                    <span style="color:#00e676;font-weight:800;">&#10003;</span> &nbsp;Apuesta del Dia con probabilidades de 92-95%
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#f0f0ff;font-size:14px;line-height:1.6;">
                    <span style="color:#00e676;font-weight:800;">&#10003;</span> &nbsp;Combinadas automaticas y goleadores con 8-10 picks diarios
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#f0f0ff;font-size:14px;line-height:1.6;">
                    <span style="color:#00e676;font-weight:800;">&#10003;</span> &nbsp;Mas de 15 ligas internacionales en tiempo real
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#f0f0ff;font-size:14px;line-height:1.6;">
                    <span style="color:#00e676;font-weight:800;">&#10003;</span> &nbsp;Corners, tarjetas, BTTS, primer gol, marcadores en vivo
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#f0f0ff;font-size:14px;line-height:1.6;">
                    <span style="color:#00e676;font-weight:800;">&#10003;</span> &nbsp;Modelos calibrados con miles de partidos historicos
                  </td>
                </tr>
              </table>

              <div style="background:linear-gradient(135deg,rgba(0,230,118,0.08),rgba(124,77,255,0.08));border:1px solid rgba(0,230,118,0.2);border-radius:12px;padding:18px 20px;margin:0 0 28px;">
                <p style="color:#00e676;font-size:13px;font-weight:800;letter-spacing:1px;margin:0 0 6px;">EL COSTO REAL</p>
                <p style="color:#f0f0ff;font-size:15px;line-height:1.6;margin:0;">
                  Una sola apuesta perdida por mala lectura cuesta mas que un mes completo de analisis.
                  Por menos de lo que gastas en una cena, tienes <strong>ventaja matematica todos los dias</strong>.
                </p>
              </div>

              <h2 style="color:#f0f0ff;font-size:20px;font-weight:800;margin:0 0 18px;text-align:center;">
                Elige tu plan y empieza hoy
              </h2>

              ${plansHtml}

              <p style="color:#8888aa;font-size:12px;line-height:1.6;margin:24px 0 0;text-align:center;">
                Cobro automatico al final de cada periodo.<br>
                Cancelas cuando quieras, sin compromiso.
              </p>

            </td>
          </tr>

          <tr>
            <td align="center" style="padding:28px 0 0;color:#444460;font-size:12px;line-height:1.6;">
              CFanalisis.com &mdash; Tu ventaja en cada apuesta<br>
              Si ya tienes plan activo, ignora este correo.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── ZeptoMail send ───────────────────────────────────────────────────────────
async function sendOne({ to, name }) {
  const html = buildHtml(name);
  const res = await fetch('https://api.zeptomail.eu/v1.1/email', {
    method: 'POST',
    headers: {
      Authorization: ZEPTOMAIL_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      from: { address: 'info@cfanalisis.com', name: 'CF Analisis' },
      to: [{ email_address: { address: to, name: name || to } }],
      subject: 'Activa tu plan en CF Analisis — Anual €100 (antes €120)',
      htmlbody: html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ZeptoMail ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── PostgreSQL local/directo ─────────────────────────────────────────────────
async function fetchAllUsers() {
  const { rows } = await pool.query(
    'SELECT email, name, subscription_status, role FROM user_profiles ORDER BY created_at ASC',
  );
  return rows;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (TEST_EMAIL) {
    console.log(`Sending TEST email to: ${TEST_EMAIL}`);
    await sendOne({ to: TEST_EMAIL, name: 'Ferney' });
    console.log('Sent.');
    return;
  }

  const users = await fetchAllUsers();
  const valid = users.filter((u) => u.email && u.email.includes('@'));
  console.log(`Recipients: ${valid.length} (total in DB: ${users.length})`);

  if (DRY) {
    valid.forEach((u) => console.log(`  - ${u.email}  [${u.subscription_status || 'none'}]`));
    console.log('\nDRY mode — no emails sent.');
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const u of valid) {
    try {
      await sendOne({ to: u.email, name: u.name });
      ok++;
      console.log(`  [${ok + fail}/${valid.length}] OK   ${u.email}`);
    } catch (e) {
      fail++;
      console.log(`  [${ok + fail}/${valid.length}] FAIL ${u.email} — ${e.message}`);
    }
    await sleep(200);
  }
  console.log(`\nDone. Sent: ${ok}, Failed: ${fail}`);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
}).finally(() => pool.end().catch(() => {}));
