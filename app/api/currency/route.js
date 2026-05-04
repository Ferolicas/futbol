import { convertAmount, getCurrencyFromCountry, SUPPORTED_CURRENCIES } from '../../../lib/currency';
import { PLANS, PLAN_IDS } from '../../../lib/stripe';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const country = searchParams.get('country');
  const currency = searchParams.get('currency');

  const targetCurrency = currency || (country ? getCurrencyFromCountry(country) : 'USD');

  try {
    // Convierte el precio de cada plan a la moneda local en paralelo
    const conversions = await Promise.all(
      PLAN_IDS.map((id) => convertAmount(PLANS[id].price / 100, targetCurrency))
    );

    const plans = {};
    PLAN_IDS.forEach((id, idx) => {
      const cfg = PLANS[id];
      plans[id] = {
        usd: cfg.price / 100,
        local: conversions[idx].amount,
        currency: targetCurrency,
        label: cfg.label,
        name: cfg.name,
        interval: cfg.interval,
        intervalCount: cfg.intervalCount,
      };
    });

    return Response.json({
      currency: targetCurrency,
      rate: conversions[0]?.rate ?? 1,
      plans,
      supportedCurrencies: SUPPORTED_CURRENCIES,
    });
  } catch (error) {
    console.error('Currency API error:', error);
    return Response.json({ error: 'Failed to get exchange rates' }, { status: 500 });
  }
}
