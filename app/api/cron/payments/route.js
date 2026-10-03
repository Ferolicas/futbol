import { pgPool } from '../../../../lib/db';
import {
  deliverActivationEmail,
  expireElapsedEntitlements,
  listActivationEmailsForRetry,
  listPaymentAttemptsForReconciliation,
  listPaymentProfilesForReconciliation,
  markPaymentProfileReconciled,
  updatePaymentAttempt,
} from '../../../../lib/payment-store';
import { processMarketingCampaigns } from '../../../../lib/marketing-campaigns';
import {
  reconcilePaymentAttempt,
  reconcilePaymentProfile,
} from '../../../../lib/payment-reconcile';
import { isCronAuthorized } from '../../../../lib/internal-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function run(request) {
  if (!isCronAuthorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const lockClient = await pgPool.connect();
  const locked = (await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtext('cfanalisis:payment-reconcile')) AS locked",
  )).rows[0]?.locked;
  if (!locked) {
    lockClient.release();
    return Response.json({ ok: true, skipped: 'already_running' });
  }

  const summary = { attempts: 0, profiles: 0, expired: 0, emails: 0, marketing: null, errors: [] };
  try {
    const attempts = await listPaymentAttemptsForReconciliation(40);
    for (const attempt of attempts) {
      try {
        await reconcilePaymentAttempt(attempt);
        summary.attempts += 1;
      } catch (error) {
        await updatePaymentAttempt(attempt.id, {
          last_reconciled_at: new Date().toISOString(),
          error_message: `reconcile: ${String(error.message || error).slice(0, 500)}`,
        }).catch(() => {});
        summary.errors.push({ scope: 'attempt', id: attempt.id, message: String(error.message || error).slice(0, 180) });
      }
    }

    const profiles = await listPaymentProfilesForReconciliation(40);
    for (const profile of profiles) {
      try {
        await reconcilePaymentProfile(profile);
        summary.profiles += 1;
      } catch (error) {
        await markPaymentProfileReconciled(profile.id).catch(() => {});
        summary.errors.push({ scope: 'profile', id: profile.id, message: String(error.message || error).slice(0, 180) });
      }
    }

    summary.expired = await expireElapsedEntitlements();

    const emails = await listActivationEmailsForRetry(20);
    for (const row of emails) {
      if (await deliverActivationEmail(row.id)) summary.emails += 1;
    }

    try {
      summary.marketing = await processMarketingCampaigns(20);
    } catch (error) {
      summary.errors.push({ type: 'marketing', error: error.message });
    }

    if (summary.errors.length) {
      console.error('[payments:reconcile]', JSON.stringify(summary.errors));
    }
    return Response.json({ ok: summary.errors.length === 0, ...summary });
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('cfanalisis:payment-reconcile'))").catch(() => {});
    lockClient.release();
  }
}

export const GET = run;
export const POST = run;
