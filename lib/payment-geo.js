import { getCurrencyFromCountry } from './currency';

function cleanCountry(value) {
  const country = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null;
}

function cleanCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

export function countryFromHeaders(request) {
  return cleanCountry(
    request.headers.get('cf-ipcountry')
    || request.headers.get('x-vercel-ip-country')
    || request.headers.get('x-country-code'),
  );
}

export async function resolvePaymentGeo(request, hints = {}) {
  const headerCountry = countryFromHeaders(request);
  if (headerCountry) {
    return {
      country: headerCountry,
      currency: getCurrencyFromCountry(headerCountry),
      source: 'edge',
    };
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || null;
  if (ip && !['::1', '127.0.0.1'].includes(ip)) {
    try {
      const response = await fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=countryCode,currency`,
        { cache: 'no-store', signal: AbortSignal.timeout(4_000) },
      );
      if (response.ok) {
        const data = await response.json();
        const country = cleanCountry(data.countryCode);
        if (country) {
          return {
            country,
            currency: cleanCurrency(data.currency) || getCurrencyFromCountry(country),
            source: 'ip',
          };
        }
      }
    } catch {}
  }

  // Solo fallback de UX. El monto siempre se recalcula en servidor y una moneda
  // manipulada no cambia el valor EUR de referencia.
  const country = cleanCountry(hints.country);
  return {
    country,
    currency: cleanCurrency(hints.currency) || (country ? getCurrencyFromCountry(country) : 'EUR'),
    source: 'hint',
  };
}
