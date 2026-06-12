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

    const { plan } = await request.json().catch(() => ({}));
    if (!isValidPlan(plan)) {
      return Response.json({ error: 'Plan inválido' }, { status: 400 });
    }

    const backUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://cfanalisis.com'}/dashboard`;
    const { id, initPoint, amountCop } = await createPreapproval({
      plan, email: user.email, userId: user.id, backUrl,
    });

    // Guardamos el preapproval id + provider. El plan NO se activa aquí: queda
    // 'pending' hasta que el webhook confirme la autorización del pago.
    const { error } = await supabaseAdmin.from('user_profiles').update({
      mp_preapproval_id: id,
      payment_provider: 'mercadopago',
      subscription_status: 'pending',
      plan,
      updated_at: new Date().toISOString(),
    }).eq('id', user.id);
    if (error) console.error('[mp:subscribe] update:', error.message);

    return Response.json({ initPoint, amountCop });
  } catch (e) {
    console.error('[mp:subscribe]', e.message);
    return Response.json({ error: 'No se pudo iniciar el pago' }, { status: 500 });
  }
}
