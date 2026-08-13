const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

process.env.MP_WEBHOOK_SECRET = 'test-webhook-secret';

function signedRequest({ dataId, requestId, ts = '1781009491' }) {
  const manifest = [
    dataId ? `id:${String(dataId).toLowerCase()};` : '',
    requestId ? `request-id:${requestId};` : '',
    `ts:${ts};`,
  ].join('');
  const v1 = createHmac('sha256', process.env.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  const headers = new Headers({ 'x-signature': `ts=${ts},v1=${v1}` });
  if (requestId) headers.set('x-request-id', requestId);
  return new Request('https://cfanalisis.com/api/mercadopago/webhook', { headers });
}

test('Mercado Pago valida el manifest oficial completo y normaliza data.id', async () => {
  const { verifyMercadoPagoWebhookSignature } = await import('../lib/mercadopago-webhook-signature.js');
  const request = signedRequest({ dataId: 'ABC-123', requestId: 'req-1' });
  assert.equal(verifyMercadoPagoWebhookSignature({
    secret: process.env.MP_WEBHOOK_SECRET,
    xSignature: request.headers.get('x-signature'),
    xRequestId: request.headers.get('x-request-id'),
    dataId: 'ABC-123',
  }), true);
});

test('Mercado Pago omite del manifest los pares ausentes', async () => {
  const { verifyMercadoPagoWebhookSignature } = await import('../lib/mercadopago-webhook-signature.js');
  const request = signedRequest({ dataId: null, requestId: null });
  assert.equal(verifyMercadoPagoWebhookSignature({
    secret: process.env.MP_WEBHOOK_SECRET,
    xSignature: request.headers.get('x-signature'),
    xRequestId: null,
    dataId: null,
  }), true);
});

test('Mercado Pago no sustituye data.id firmado por un id distinto', async () => {
  const { verifyMercadoPagoWebhookSignature } = await import('../lib/mercadopago-webhook-signature.js');
  const request = signedRequest({ dataId: '123', requestId: 'req-2' });
  assert.equal(verifyMercadoPagoWebhookSignature({
    secret: process.env.MP_WEBHOOK_SECRET,
    xSignature: request.headers.get('x-signature'),
    xRequestId: request.headers.get('x-request-id'),
    dataId: '999',
  }), false);
});
