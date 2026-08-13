import { createHmac, timingSafeEqual } from 'crypto';

// Validador aislado para que el contrato criptográfico pueda probarse sin
// cargar los clientes de pagos/BD de la integración completa.
export function verifyMercadoPagoWebhookSignature({ secret, xSignature, xRequestId, dataId }) {
  if (!secret || !xSignature) return null;
  try {
    let ts;
    let v1;
    for (const part of xSignature.split(',')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key === 'ts') ts = val;
      else if (key === 'v1') v1 = val;
    }
    if (!ts || !v1) return false;

    const rawId = dataId == null ? '' : String(dataId);
    const id = /[A-Z]/.test(rawId) ? rawId.toLowerCase() : rawId;
    const manifest = [
      id ? `id:${id};` : '',
      xRequestId ? `request-id:${xRequestId};` : '',
      `ts:${ts};`,
    ].join('');
    const expected = createHmac('sha256', secret).update(manifest).digest('hex');
    const actual = String(v1);
    if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(actual, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
