import { pgPool } from '../../../../lib/db';
import {
  deliverActivationEmail,
  listActivationEmailsForRetry,
  listPaymentAttemptsForReconciliation,
  listPaymentProfilesForReconciliation,
  markPaymentProfileReconciled,
  updatePaymentAttempt,
} from '../../../../lib/payment-store';
import {
  reconcilePaymentAttempt,
  reconcilePaymentProfile,
} from '../../../../lib/payment-reconcile';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request) {
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    || request.headers.get('x-cron-secret');
  return !!process.env.CRON_SECRET && supplied === process.env.CRON_SECRET;
}

async function run(request) {
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const lockClient = await pgPool.connect();
  const locked = (await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtext('cfanalisis:payment-reconcile')) AS locked",
  )).rows[0]?.locked;
  if (!locked) {
    lockClient.release();
    return Response.json({ ok: true, skipped: 'already_running' });
  }

  const summary = { attempts: 0, profiles: 0, emails: 0, errors: [] };
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

    const emails = await listActivationEmailsForRetry(20);
    for (const row of emails) {
      if (await deliverActivationEmail(row.id)) summary.emails += 1;
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
