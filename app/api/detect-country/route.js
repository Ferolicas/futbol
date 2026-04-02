import { getCurrencyFromCountry } from '../../../lib/currency';

export async function GET(request) {
  // En Vercel producción, este header viene gratis sin API externa
  const vercelCountry = request.headers.get('x-vercel-ip-country');
  if (vercelCountry) {
    return Response.json({
      countryCode: vercelCountry,
      currency: getCurrencyFromCountry(vercelCountry),
    });
  }

  // Fallback: ip-api.com server-side (sin mixed content)
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null;

  if (ip && ip !== '::1' && ip !== '127.0.0.1') {
    try {
      const res = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,currency`, {
        next: { revalidate: 0 },
      });
      const data = await res.json();
      if (data.countryCode) {
        return Response.json({ countryCode: data.countryCode, currency: data.currency || getCurrencyFromCountry(data.countryCode) });
      }
    } catch {}
  }

  // En local (localhost) no hay IP real — devolver null para que el cliente muestre USD
  return Response.json({ countryCode: null, currency: 'USD' });
}
