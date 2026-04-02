export async function GET(request) {
  // Get client IP from Vercel/proxy headers
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '8.8.8.8';

  try {
    // Server-side call — no mixed content issues
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,currency`, {
      next: { revalidate: 0 },
    });
    const data = await res.json();
    return Response.json({ countryCode: data.countryCode || 'US', currency: data.currency || 'USD' });
  } catch {
    return Response.json({ countryCode: 'US', currency: 'USD' });
  }
}
