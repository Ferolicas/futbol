// POST /api/mercadopago/subscribe  { plan }
// Crea la suscripción de Mercado Pago (preapproval) para el usuario autenticado
// y devuelve el init_point al que el frontend redirige para pagar/autorizar.
// Solo para Colombia (el geo-routing lo decide /planes).
import { getCurrentUser } from '../../../../lib/auth-pg';
import { createPreapproval, isValidPlan } from '../../../../lib/mercadopago';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { plan, cardToken, paymentMethodId } = await request.json().catch(() => ({}));
    if (!isValidPlan(plan)) {
      return Response.json({ error: 'Plan inválido' }, { status: 400 });
    }

    const backUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://cfanalisis.com'}/dashboard`;
    const { id, initPoint, amountCop, status } = await createPreapproval({
      plan, email: user.email, userId: user.id, backUrl, cardToken,
    });

    // Con tarjeta tokenizada el preapproval queda 'authorized' → activamos ya.
    // Sin tarjeta (flujo init_point) queda 'pending' hasta que el webhook confirme.
    const active = status === 'authorized';
    const { error } = await supabaseAdmin.from('user_profiles').update({
      mp_preapproval_id: id,
      payment_provider: 'mercadopago',
      subscription_status: active ? 'active' : 'pending',
      plan,
      updated_at: new Date().toISOString(),
    }).eq('id', user.id);
    if (error) console.error('[mp:subscribe] update:', error.message);

    // Modal (Card Brick): devolvemos ok según el estado real de MP.
    if (cardToken) return Response.json({ ok: active, status });
    // Fallback redirigido.
    return Response.json({ initPoint, amountCop });
  } catch (e) {
    console.error('[mp:subscribe]', e.message);
    // Propagamos un mensaje útil (ej. en sandbox: "payer must be a test user").
    const msg = /test user|real or test/i.test(e.message)
      ? 'En modo prueba el pagador debe ser un usuario de prueba de Mercado Pago.'
      : 'No se pudo procesar el pago. Intenta de nuevo.';
    return Response.json({ error: msg }, { status: 500 });
  }
}
