import { randomUUID } from 'crypto';
import { pgPool, pgQuery } from './db';
import { sendMarketingEmail } from './email';
import { createMarketingUnsubscribeToken } from './legal';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://cfanalisis.com';

export async function createMarketingCampaign({ createdBy, subject, message, ctaLabel = null, ctaUrl = null, assets = [] }) {
  const campaignId = randomUUID();
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO public.marketing_campaigns
         (id, subject, message, cta_label, cta_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [campaignId, subject, message, ctaLabel, ctaUrl, createdBy],
    );
    for (const asset of assets) {
      const assetId = randomUUID();
      await client.query(
        `INSERT INTO public.marketing_campaign_assets
           (id, campaign_id, filename, content_type, disposition, content_id, content, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          assetId,
          campaignId,
          asset.filename,
          asset.contentType,
          asset.disposition,
          asset.disposition === 'inline' ? `campaign-${assetId}` : null,
          asset.content,
          asset.content.length,
        ],
      );
    }
    const inserted = await client.query(
      `WITH latest AS (
         SELECT DISTINCT ON (user_id) user_id, action
           FROM public.marketing_consent_events
          ORDER BY user_id, occurred_at DESC, id DESC
       )
       INSERT INTO public.marketing_campaign_deliveries (campaign_id, user_id)
       SELECT $1, latest.user_id
         FROM latest
         JOIN public.user_profiles p ON p.id = latest.user_id
        WHERE latest.action = 'consent'
          AND p.role = 'user'
          AND p.email IS NOT NULL
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [campaignId],
    );
    await client.query(
      `UPDATE public.marketing_campaigns SET recipient_count = $2 WHERE id = $1`,
      [campaignId, inserted.rowCount || 0],
    );
    if (!inserted.rowCount) {
      await client.query(
        `UPDATE public.marketing_campaigns SET status='completed', completed_at=NOW() WHERE id=$1`,
        [campaignId],
      );
    }
    await client.query('COMMIT');
    return { id: campaignId, recipientCount: inserted.rowCount || 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function claimDeliveries(limit) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE public.marketing_campaign_deliveries
          SET status='failed', attempts=3,
              error_message='ambiguous_delivery_outside_idempotency_window', updated_at=NOW()
        WHERE status='sending' AND updated_at < NOW() - interval '23 hours'`,
    );
    const result = await client.query(
      `WITH candidates AS (
         SELECT d.campaign_id, d.user_id
           FROM public.marketing_campaign_deliveries d
           JOIN public.marketing_campaigns c ON c.id = d.campaign_id
          WHERE c.status IN ('queued', 'sending')
            AND (
              d.status = 'pending'
              OR (d.status = 'failed' AND d.attempts < 3)
              OR (d.status = 'sending'
                  AND d.updated_at < NOW() - interval '30 minutes'
                  AND d.updated_at >= NOW() - interval '23 hours')
            )
          ORDER BY c.created_at, d.updated_at
          FOR UPDATE OF d SKIP LOCKED
          LIMIT $1
       )
       UPDATE public.marketing_campaign_deliveries d
          SET status = 'sending', attempts = attempts + 1, updated_at = NOW(), error_message = NULL
         FROM candidates
        WHERE d.campaign_id = candidates.campaign_id AND d.user_id = candidates.user_id
       RETURNING d.campaign_id, d.user_id, d.attempts`,
      [limit],
    );
    if (result.rows.length) {
      await client.query(
        `UPDATE public.marketing_campaigns SET status = 'sending'
          WHERE id = ANY($1::uuid[]) AND status = 'queued'`,
        [[...new Set(result.rows.map((row) => row.campaign_id))]],
      );
    }
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function stillConsented(userId) {
  const result = await pgQuery(
    `SELECT action FROM public.marketing_consent_events
      WHERE user_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.action === 'consent';
}

async function finishCampaigns() {
  await pgQuery(
    `WITH totals AS (
       SELECT campaign_id,
              count(*) FILTER (WHERE status = 'sent')::int AS sent,
              count(*) FILTER (WHERE status = 'failed' AND attempts >= 3)::int AS failed,
              count(*) FILTER (WHERE status IN ('pending', 'sending') OR (status='failed' AND attempts < 3))::int AS open
         FROM public.marketing_campaign_deliveries
        GROUP BY campaign_id
     )
     UPDATE public.marketing_campaigns c
        SET sent_count = totals.sent,
            failed_count = totals.failed,
            status = CASE WHEN totals.open = 0 THEN
              CASE WHEN totals.failed > 0 THEN 'completed_with_errors' ELSE 'completed' END
              ELSE c.status END,
            completed_at = CASE WHEN totals.open = 0 THEN COALESCE(c.completed_at, NOW()) ELSE NULL END
       FROM totals
      WHERE c.id = totals.campaign_id`,
  );
}

export async function processMarketingCampaigns(limit = 20) {
  const claimed = await claimDeliveries(limit);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const delivery of claimed) {
    try {
      if (!(await stillConsented(delivery.user_id))) {
        await pgQuery(
          `UPDATE public.marketing_campaign_deliveries SET status='skipped', updated_at=NOW()
            WHERE campaign_id=$1 AND user_id=$2`,
          [delivery.campaign_id, delivery.user_id],
        );
        skipped += 1;
        continue;
      }
      const data = await pgQuery(
        `SELECT c.subject, c.message, c.cta_label, c.cta_url, p.email, p.name
           FROM public.marketing_campaigns c
           JOIN public.user_profiles p ON p.id = $2
          WHERE c.id = $1`,
        [delivery.campaign_id, delivery.user_id],
      );
      const row = data.rows[0];
      if (!row?.email) throw new Error('recipient_email_missing');
      const assetRows = await pgQuery(
        `SELECT filename, content_type, disposition, content_id, content
           FROM public.marketing_campaign_assets
          WHERE campaign_id = $1 ORDER BY created_at, id`,
        [delivery.campaign_id],
      );
      const attachments = assetRows.rows.map((asset) => ({
        filename: asset.filename,
        content: Buffer.from(asset.content).toString('base64'),
        content_type: asset.content_type,
        ...(asset.disposition === 'inline' ? { content_id: asset.content_id } : {}),
      }));
      const token = createMarketingUnsubscribeToken(delivery.user_id);
      const unsubscribeUrl = `${APP_URL}/preferencias/comunicaciones/baja?token=${encodeURIComponent(token)}`;
      const oneClickUnsubscribeUrl = `${APP_URL}/api/legal/marketing/unsubscribe?token=${encodeURIComponent(token)}`;
      const provider = await sendMarketingEmail({
        to: row.email,
        name: row.name,
        subject: row.subject,
        message: row.message,
        ctaLabel: row.cta_label,
        ctaUrl: row.cta_url,
        unsubscribeUrl,
        oneClickUnsubscribeUrl,
        idempotencyKey: `marketing/${delivery.campaign_id}/${delivery.user_id}`,
        attachments,
      });
      await pgQuery(
        `UPDATE public.marketing_campaign_deliveries
            SET status='sent', provider_id=$3, sent_at=NOW(), updated_at=NOW()
          WHERE campaign_id=$1 AND user_id=$2`,
        [delivery.campaign_id, delivery.user_id, provider?.id || null],
      );
      sent += 1;
    } catch (error) {
      await pgQuery(
        `UPDATE public.marketing_campaign_deliveries
            SET status='failed', error_message=$3, updated_at=NOW()
          WHERE campaign_id=$1 AND user_id=$2`,
        [delivery.campaign_id, delivery.user_id, String(error.message || error).slice(0, 800)],
      ).catch(() => {});
      failed += 1;
    }
  }
  await finishCampaigns();
  return { claimed: claimed.length, sent, skipped, failed };
}
