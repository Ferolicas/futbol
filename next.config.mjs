/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Standalone output: copia solo el bundle minimo necesario + node_modules
  // de dependencias usadas a .next/standalone/. Permite arrancar la app con
  // `node .next/standalone/server.js` en cualquier host (VPS, Docker, etc.)
  // sin necesidad de instalar el package.json completo en produccion.
  output: 'standalone',

  images: {
    unoptimized: true,
  },

  env: {
    NEXT_PUBLIC_VAPID_KEY: process.env.VAPID_PUBLIC_KEY || '',
  },

  // A1 FIX: headers de seguridad HTTP (exigidos por CLAUDE.md §2.3 y antes ausentes).
  // La CSP es deliberadamente permisiva en img/connect/frame para NO romper:
  //   - imágenes externas (media.api-sports.io, mlbstatic.com) → img-src https:
  //   - WebSocket del worker (wss://worker.cfanalisis.com) → connect-src wss:
  //   - Stripe (PaymentElement en iframe) → frame-src/script-src js.stripe.com
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://js.stripe.com https://sdk.mercadopago.com https://*.mercadopago.com https://*.mlstatic.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https: wss:",
      "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://*.mercadopago.com https://*.mercadolibre.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; ');
    const securityHeaders = [
      { key: 'X-DNS-Prefetch-Control', value: 'on' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Content-Security-Policy', value: csp },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    ];
    return [{ source: '/:path*', headers: securityHeaders }, ...['/api/fixtures', '/api/match/:id', '/api/baseball/fixtures', '/api/baseball/match/:id', '/api/sports/:sport/fixtures', '/api/sports/:sport/match/:id', '/api/auth/session', '/api/realtime/token', '/api/free/visit'].map(source => ({ source, headers: [{ key: 'Cache-Control', value: 'private, no-store' }] }))];
  },
};

export default nextConfig;
