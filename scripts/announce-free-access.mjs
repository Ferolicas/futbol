// Explicitly requested launch announcement. Default is a dry run.
// node --env-file=.env.local scripts/announce-free-access.mjs [--send]
// Resend idempotency: https://resend.com/docs/dashboard/emails/idempotency-keys
import pg from 'pg';
import { writeFile } from 'node:fs/promises';
import { FREE_ANNOUNCEMENT_VERSION, FREE_ANNOUNCEMENT_SUBJECT, FREE_ANNOUNCEMENT_HTML } from '../lib/free-announcement-template.js';
import { hasActiveEntitlement } from '../lib/entitlements.js';

const CAMPAIGN = 'free-access-launch-2026-09-06';
const send = process.argv.includes('--send');
const testIndex = process.argv.indexOf('--test');
const testEmail = testIndex >= 0 ? process.argv[testIndex + 1] : null;
if (testIndex >= 0 && (!testEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testEmail))) throw new Error('--test requires an email');
if (testEmail && send) throw new Error('Choose --test or --send');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 2 });
const subject = FREE_ANNOUNCEMENT_SUBJECT;
const html = FREE_ANNOUNCEMENT_HTML;


try {
  await writeFile('/tmp/cf-free-announcement.html', html, { mode: 0o600 });
  if (testEmail) {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${CAMPAIGN}/preview-${FREE_ANNOUNCEMENT_VERSION}/${testEmail}` },
      body: JSON.stringify({ from: process.env.FROM_EMAIL || 'CF Análisis <info@cfanalisis.com>', to: [testEmail], subject: `[Vista previa] ${subject}`, html }),
    });
    const result = await response.json();
    if (!response.ok || !result.id) throw new Error(`Preview failed: HTTP ${response.status} ${result.name || ''}`);
    console.log(JSON.stringify({ previewSent: true, to: testEmail, providerId: result.id }));
  } else {
  const { rows } = await pool.query(`SELECT u.id,u.email,p.role,p.subscription_status,p.plan_expires_at,p.subscription_current_period_end,p.cancel_at_period_end
    FROM users u LEFT JOIN user_profiles p ON p.id=u.id ORDER BY u.created_at`);
  const recipients = rows.filter(row => !hasActiveEntitlement(row) && !row.email.endsWith('.invalid') && !/^cf-free-qa-/i.test(row.email));
  console.log(JSON.stringify({ campaign: CAMPAIGN, eligible: recipients.length, mode: send ? 'send' : 'dry-run', preview: '/tmp/cf-free-announcement.html' }));
  if (send && !process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
  let accepted = 0, skipped = 0, failed = 0;
  if (send) for (const recipient of recipients) {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`${CAMPAIGN}:${recipient.id}`]);
      const { rows: [profile] } = await client.query('SELECT * FROM user_profiles WHERE id=$1', [recipient.id]);
      if (hasActiveEntitlement(profile)) { skipped++; continue; }
      const { rows: [existing] } = await client.query('SELECT * FROM email_campaign_deliveries WHERE campaign=$1 AND user_id=$2', [CAMPAIGN, recipient.id]);
      if (existing?.status === 'sent') { skipped++; continue; }
      if (existing?.status === 'sending' && Date.now() - new Date(existing.updated_at).getTime() > 23 * 3600_000) {
        throw new Error('Ambiguous delivery outside provider idempotency window; inspect before retry');
      }
      await client.query("INSERT INTO email_campaign_deliveries(campaign,user_id,status) VALUES($1,$2,'sending') ON CONFLICT(campaign,user_id) DO UPDATE SET status='sending',updated_at=now()", [CAMPAIGN, recipient.id]);
      let response, result;
      for (let attempt = 0; attempt < 4; attempt++) {
        response = await fetch('https://api.resend.com/emails', {
          method: 'POST', signal: AbortSignal.timeout(20000),
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${CAMPAIGN}/${recipient.id}` },
          body: JSON.stringify({ from: process.env.FROM_EMAIL || 'CF Análisis <info@cfanalisis.com>', to: [recipient.email], subject, html }),
        });
        result = await response.json();
        if (response.ok || (response.status !== 429 && response.status < 500)) break;
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
      }
      if (!response.ok || !result.id) {
        await client.query("UPDATE email_campaign_deliveries SET status='failed',updated_at=now() WHERE campaign=$1 AND user_id=$2", [CAMPAIGN, recipient.id]);
        throw new Error(`Resend HTTP ${response.status}: ${result.name || 'send failed'}`);
      }
      await client.query("UPDATE email_campaign_deliveries SET status='sent',provider_id=$3,updated_at=now() WHERE campaign=$1 AND user_id=$2", [CAMPAIGN, recipient.id, result.id]);
      accepted++;
    } catch (error) { failed++; console.error(JSON.stringify({ recipientId: recipient.id, error: error.message })); }
    finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`${CAMPAIGN}:${recipient.id}`]);
      client.release();
    }
    await new Promise(resolve => setTimeout(resolve, 650));
  }
  console.log(JSON.stringify({ accepted, skipped, failed }));
  if (failed) process.exitCode = 1;
  }
} finally { await pool.end(); }
