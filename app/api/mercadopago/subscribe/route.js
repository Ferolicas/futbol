// POST /api/mercadopago/subscribe
// Recibe lo que envía el Payment Brick: { plan, selectedPaymentMethod, formData }.
//   - TARJETA (formData.token) → suscripción recurrente (preapproval) → activa
//     al instante, sin redirigir.  → { ok: true }
//   - PSE / Efecty (sin token) → pago del periodo vía Orders API; MP devuelve la
//     redirect_url al banco.                                  → { ok: true, redirectUrl }
import { getCurrentUser } from '../../../../lib/auth-pg';
import { createPreapproval, createOrder, isValidPlan } from '../../../../lib/mercadopago';
import { supabaseAdmin } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const { plan, cardToken, formData } = body;
    if (!isValidPlan(plan)) {
      return Response.json({ error: 'Plan inválido' }, { status: 400 });
    }

    const backUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://cfanalisis.com'}/dashboard`;
    // Token de tarjeta: del brick (formData.token) o directo (cardToken, para pruebas).
    const token = formData?.token || cardToken;

    // ── TARJETA → suscripción recurrente ──
    if (token) {
      const { id, status } = await createPreapproval({
        plan, email: user.email, userId: user.id, backUrl, cardToken: token,
      });
      const active = status === 'authorized';
      const { error } = await supabaseAdmin.from('user_profiles').update({
        mp_preapproval_id: id,
        payment_provider: 'mercadopago',
        subscription_status: active ? 'active' : 'pending',
        plan,
        updated_at: new Date().toISOString(),
      }).eq('id', user.id);
      if (error) console.error('[mp:subscribe] update:', error.message);
      return Response.json({ ok: active, status });
    }

    // ── PSE / Efecty → pago del periodo (Orders API) ──
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    // Log de la forma real del formData (sandbox no simula PSE → afinamos con la
    // primera prueba en producción).
    console.log('[mp:subscribe] PSE/otro formData:', JSON.stringify(formData || {}).slice(0, 400));
    const { id, status, redirectUrl } = await createOrder({
      plan, formData, userId: user.id, backUrl, ipAddress: ip,
    });
    const { error } = await supabaseAdmin.from('user_profiles').update({
      mp_preapproval_id: id,
      payment_provider: 'mercadopago',
      subscription_status: 'pending', // se activa cuando el webhook confirme el pago
      plan,
      updated_at: new Date().toISOString(),
    }).eq('id', user.id);
    if (error) console.error('[mp:subscribe] update:', error.message);

    return Response.json({ ok: true, status, redirectUrl });
  } catch (e) {
    console.error('[mp:subscribe]', e.message);
    const msg = /test user|real or test/i.test(e.message)
      ? 'En modo prueba el pagador debe ser un usuario de prueba de Mercado Pago.'
      : 'No se pudo procesar el pago. Intenta de nuevo.';
    return Response.json({ error: msg }, { status: 500 });
  }
}
