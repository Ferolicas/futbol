import { convertAmount, getCurrencyFromCountry, SUPPORTED_CURRENCIES } from '../../../lib/currency';
import { PLANS, PLAN_IDS } from '../../../lib/stripe';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const country = searchParams.get('country');
  const currency = searchParams.get('currency');

  const targetCurrency = currency || (country ? getCurrencyFromCountry(country) : 'USD');

  try {
    // Convierte el precio de cada plan a la moneda local en paralelo.
    // Si el plan tiene fixedCurrency=true, no se convierte (siempre se cobra en su moneda nativa).
    const conversions = await Promise.all(
      PLAN_IDS.map((id) => {
        const cfg = PLANS[id];
        const srcCurrency = (cfg.currency || 'usd').toUpperCase();
        const sourceAmount = cfg.price / 100;
        if (cfg.fixedCurrency) {
          return Promise.resolve({ amount: sourceAmount, currency: srcCurrency, rate: 1, original: sourceAmount });
        }
        return convertAmount(sourceAmount, targetCurrency, srcCurrency);
      })
    );

    const plans = {};
    PLAN_IDS.forEach((id, idx) => {
      const cfg = PLANS[id];
      const srcCurrency = (cfg.currency || 'usd').toUpperCase();
      plans[id] = {
        usd: cfg.price / 100, // legacy: amount in plan's source currency
        nativeAmount: cfg.price / 100,
        nativeCurrency: srcCurrency,
        originalAmount: cfg.originalPrice ? cfg.originalPrice / 100 : null,
        fixedCurrency: !!cfg.fixedCurrency,
        local: conversions[idx].amount,
        currency: conversions[idx].currency,
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
