import { z } from 'zod';
import { stripe, isValidPlan, PLAN_IDS } from '../../../../lib/stripe';
import { supabaseAdmin } from '../../../../lib/supabase';
import { getUserProfile } from '../../../../lib/supabase-auth';
import { logAction } from '../../../../lib/audit';
import { jsonError } from '../../../../lib/api-error';

export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const profile = await getUserProfile();
  if (!profile || !['admin', 'owner'].includes(profile.role)) return null;
  return profile;
}

export async function GET() {
  const profile = await requireAdmin();
  if (!profile) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data: users, error } = await supabaseAdmin
    .from('user_profiles')
    .select('id, email, name, role, plan, subscription_status, stripe_customer_id, created_at, updated_at')
    .order('created_at', { ascending: false });
  if (error) return jsonError(error);

  const isActive = (u) =>
    u.subscription_status === 'active' || ['admin', 'owner'].includes(u.role);

  const active = users.filter(isActive);
  const pending = users.filter((u) => !isActive(u));

  // Resolve next payment date from Stripe for each active user with customer_id
  if (stripe) {
    await Promise.all(
      active.map(async (u) => {
        if (!u.stripe_customer_id) return;
        try {
          const subs = await stripe.subscriptions.list({
            customer: u.stripe_customer_id,
            status: 'all',
            limit: 5,
          });
          const live = subs.data.find((s) =>
            ['active', 'trialing', 'past_due'].includes(s.status)
          );
          if (live?.current_period_end) {
            u.next_payment_at = new Date(live.current_period_end * 1000).toISOString();
            u.subscription_id = live.id;
            u.stripe_status = live.status;
          } else {
            // Fallback: most recent succeeded charge + 30 days
            const charges = await stripe.charges.list({
              customer: u.stripe_customer_id,
              limit: 10,
            });
            const lastPaid = charges.data
              .filter((c) => c.status === 'succeeded' && !c.refunded)
              .sort((a, b) => b.created - a.created)[0];
            if (lastPaid) {
              u.last_payment_at = new Date(lastPaid.created * 1000).toISOString();
              u.last_payment_amount = lastPaid.amount;
              u.last_payment_currency = lastPaid.currency;
              u.next_payment_at = new Date(
                (lastPaid.created + 30 * 24 * 3600) * 1000
              ).toISOString();
            }
          }
        } catch (e) {
          console.error('[admin/clients] stripe lookup', u.email, e.message);
        }
      })
    );
  }

  return Response.json({
    active: active.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      plan: u.plan,
      stripe_customer_id: u.stripe_customer_id,
      created_at: u.created_at,
      last_payment_at: u.last_payment_at || null,
      last_payment_amount: u.last_payment_amount || null,
      last_payment_currency: u.last_payment_currency || null,
      next_payment_at: u.next_payment_at || null,
      subscription_id: u.subscription_id || null,
      stripe_status: u.stripe_status || null,
    })),
    pending: pending.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      subscription_status: u.subscription_status,
      stripe_customer_id: u.stripe_customer_id,
      created_at: u.created_at,
    })),
    counts: { active: active.length, pending: pending.length },
    plans: PLAN_IDS,
  });
}

// ── POST: asignar o revocar plan manualmente (override de admin) ──────────────
//
// Body:
//   { action: 'set-plan', userId, plan }  → da acceso con el plan elegido
//                                            (subscription_status = 'active')
//   { action: 'revoke',   userId }        → revoca el acceso
//                                            (subscription_status = 'inactive',
//                                             plan = null) y cancela cualquier
//                                             suscripción viva en Stripe para que
//                                             deje de cobrar.
//
// Solo aplica a cuentas con role 'user' — las cuentas de staff (admin/owner)
// tienen acceso por rol y no se gestionan desde aquí.
const bodySchema = z.object({
  action: z.enum(['set-plan', 'revoke']),
  userId: z.string().min(1, 'userId requerido'),
  plan: z.string().optional(),
});

export async function POST(request) {
  const admin = await requireAdmin();
  if (!admin) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const raw = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'Datos inválidos', details: parsed.error.flatten() }, { status: 400 });
  }
  const { action, userId, plan } = parsed.data;

  if (action === 'set-plan' && !isValidPlan(plan)) {
    return Response.json({ error: `Plan inválido. Opciones: ${PLAN_IDS.join(', ')}` }, { status: 400 });
  }

  // Cargar el usuario destino
  const { data: target, error: targetErr } = await supabaseAdmin
    .from('user_profiles')
    .select('id, email, name, role, plan, subscription_status, stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();
  if (targetErr) return jsonError(targetErr);
  if (!target) return Response.json({ error: 'Usuario no encontrado' }, { status: 404 });

  if (['admin', 'owner'].includes(target.role)) {
    return Response.json(
      { error: 'No aplica a cuentas de staff (admin/owner): ya tienen acceso por rol.' },
      { status: 400 },
    );
  }

  let update;
  if (action === 'set-plan') {
    update = { plan, subscription_status: 'active', updated_at: new Date().toISOString() };
  } else {
    // revoke — best-effort: cancelar suscripciones vivas en Stripe para cortar el cobro
    if (stripe && target.stripe_customer_id) {
      try {
        const subs = await stripe.subscriptions.list({
          customer: target.stripe_customer_id,
          status: 'all',
          limit: 10,
        });
        await Promise.all(
          subs.data
            .filter((s) => ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status))
            .map((s) => stripe.subscriptions.cancel(s.id).catch((e) =>
              console.error('[admin/clients] cancel sub', s.id, e.message))),
        );
      } catch (e) {
        console.error('[admin/clients] stripe cancel', target.email, e.message);
      }
    }
    update = { plan: null, subscription_status: 'inactive', updated_at: new Date().toISOString() };
  }

  const { error: updErr } = await supabaseAdmin
    .from('user_profiles')
    .update(update)
    .eq('id', userId);
  if (updErr) return jsonError(updErr);

  logAction({
    userId: admin.id,
    userEmail: admin.email,
    action: action === 'set-plan' ? 'client-set-plan' : 'client-revoke',
    entity: 'user_profile',
    entityId: userId,
    payload: { targetEmail: target.email, plan: action === 'set-plan' ? plan : null },
    request,
  }).catch(() => {});

  return Response.json({
    ok: true,
    user: {
      id: target.id,
      email: target.email,
      name: target.name,
      plan: update.plan,
      subscription_status: update.subscription_status,
    },
  });
}
