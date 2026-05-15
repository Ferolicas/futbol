/**
 * lib/audit.js — registra acciones administrativas en audit_logs.
 *
 * Uso:
 *   import { logAction } from '@/lib/audit';
 *   await logAction({
 *     userId, userEmail,
 *     action: 'publish-combinada',
 *     entity: 'combinada_dia', entityId: row.id,
 *     payload: { fecha, selections: all.length },
 *     request,        // opcional — extrae IP y User-Agent automaticamente
 *   });
 *
 * Notas:
 *   - Fire-and-forget consciente: si la insercion falla, se loguea pero no
 *     propaga el error al caller (un audit-log roto NO debe romper la
 *     operacion auditada).
 *   - Sin PII en payload — el objetivo es trazabilidad, no analytics.
 */

import { supabaseAdmin } from './supabase';

function extractIp(request) {
  if (!request) return null;
  // Vercel pone la IP real en x-forwarded-for; tomamos el primer hop.
  const xff = request.headers?.get?.('x-forwarded-for')
            || request.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  const real = request.headers?.get?.('x-real-ip')
            || request.headers?.['x-real-ip'];
  return typeof real === 'string' ? real : null;
}

function extractUa(request) {
  if (!request) return null;
  return request.headers?.get?.('user-agent')
      || request.headers?.['user-agent']
      || null;
}

export async function logAction({
  userId,
  userEmail = null,
  action,
  entity = null,
  entityId = null,
  payload = null,
  request = null,
}) {
  if (!userId || !action) {
    console.warn('[audit] logAction llamado sin userId o action — skip');
    return;
  }
  try {
    const ip = extractIp(request);
    const ua = extractUa(request);
    const { error } = await supabaseAdmin.from('audit_logs').insert({
      user_id:    userId,
      user_email: userEmail,
      action,
      entity,
      entity_id: entityId == null ? null : String(entityId),
      payload:   payload ?? null,
      ip,
      user_agent: ua,
    });
    if (error) {
      console.error('[audit] insert fallo:', error.message);
    }
  } catch (e) {
    console.error('[audit] excepcion:', e.message);
  }
}
