import { getUserProfile } from '../../../../lib/supabase-auth';
import { pgQuery } from '../../../../lib/db';
import { z } from 'zod';
import { createMarketingCampaign } from '../../../../lib/marketing-campaigns';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  const profile = await getUserProfile();
  if (!profile || !['admin', 'owner'].includes(profile.role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const result = await pgQuery(
    `WITH latest AS (
       SELECT DISTINCT ON (user_id) user_id, action, occurred_at, policy_version
         FROM public.marketing_consent_events
        ORDER BY user_id, occurred_at DESC, id DESC
     )
     SELECT p.id, p.name, p.email, p.plan, p.subscription_status,
            latest.occurred_at AS consented_at, latest.policy_version
       FROM latest
       JOIN public.user_profiles p ON p.id = latest.user_id
      WHERE latest.action = 'consent' AND p.role = 'user'
      ORDER BY latest.occurred_at DESC`,
  );
  const campaigns = await pgQuery(
    `SELECT id, subject, status, recipient_count, sent_count, failed_count, created_at, completed_at
       FROM public.marketing_campaigns ORDER BY created_at DESC LIMIT 20`,
  );
  return Response.json({ recipients: result.rows, count: result.rowCount || 0, campaigns: campaigns.rows });
}

const campaignSchema = z.object({
  subject: z.string().trim().min(3).max(140),
  message: z.string().trim().min(10).max(5000),
  ctaLabel: z.string().trim().max(60).optional().default(''),
  ctaUrl: z.string().trim().max(500).optional().default(''),
});

const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);
const ATTACHMENT_TYPES = new Set([
  ...INLINE_TYPES,
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function validCtaUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['cfanalisis.com', 'www.cfanalisis.com'].includes(url.hostname)
      ? url.toString()
      : null;
  } catch { return null; }
}

export async function POST(request) {
  const profile = await getUserProfile();
  if (!profile || !['admin', 'owner'].includes(profile.role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const limit = await redisRateLimit('admin-marketing-send', profile.id, 3, 60 * 60, { failClosed: true });
  if (!limit.success) return Response.json({ error: 'Límite de campañas alcanzado. Espera una hora.' }, { status: 429 });

  const form = await request.formData();
  const parsed = campaignSchema.safeParse({
    subject: form.get('subject'),
    message: form.get('message'),
    ctaLabel: form.get('ctaLabel') || '',
    ctaUrl: form.get('ctaUrl') || '',
  });
  if (!parsed.success) return Response.json({ error: 'Revisa asunto, mensaje y botón.' }, { status: 400 });
  const ctaUrl = validCtaUrl(parsed.data.ctaUrl);
  if (parsed.data.ctaUrl && !ctaUrl) {
    return Response.json({ error: 'El enlace del botón debe pertenecer a https://cfanalisis.com.' }, { status: 400 });
  }
  if ((parsed.data.ctaLabel && !ctaUrl) || (!parsed.data.ctaLabel && ctaUrl)) {
    return Response.json({ error: 'El botón necesita texto y enlace.' }, { status: 400 });
  }

  const files = [
    ...form.getAll('inlineImages').map((file) => ({ file, disposition: 'inline' })),
    ...form.getAll('attachments').map((file) => ({ file, disposition: 'attachment' })),
  ];
  if (files.length > 8) return Response.json({ error: 'Máximo 8 archivos por campaña.' }, { status: 400 });
  let totalBytes = 0;
  const assets = [];
  for (const item of files) {
    const { file, disposition } = item;
    if (!file || typeof file.arrayBuffer !== 'function' || file.size <= 0 || file.size > MAX_FILE_BYTES) {
      return Response.json({ error: 'Cada archivo debe pesar entre 1 byte y 5 MB.' }, { status: 400 });
    }
    const allowed = disposition === 'inline' ? INLINE_TYPES : ATTACHMENT_TYPES;
    if (!allowed.has(file.type)) {
      return Response.json({ error: `Tipo de archivo no permitido: ${file.name}` }, { status: 400 });
    }
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return Response.json({ error: 'Los archivos no pueden superar 12 MB en total.' }, { status: 400 });
    }
    assets.push({
      filename: String(file.name || 'archivo').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120),
      contentType: file.type,
      disposition,
      content: Buffer.from(await file.arrayBuffer()),
    });
  }

  const campaign = await createMarketingCampaign({
    createdBy: profile.id,
    subject: parsed.data.subject,
    message: parsed.data.message,
    ctaLabel: parsed.data.ctaLabel || null,
    ctaUrl,
    assets,
  });
  return Response.json({ ok: true, campaign });
}
