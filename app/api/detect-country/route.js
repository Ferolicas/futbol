import { resolvePaymentGeo } from '../../../lib/payment-geo';

export async function GET(request) {
  const geo = await resolvePaymentGeo(request);
  return Response.json({ countryCode: geo.country, currency: geo.currency });
}
