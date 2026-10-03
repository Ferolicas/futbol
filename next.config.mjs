/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Cada release se construye dentro de `.web-releases/`, debajo de otra copia
  // del repositorio. Sin raíces explícitas Next 16 detecta el lockfile padre y
  // anida `server.js`, rompiendo el runtime standalone esperado por PM2.
  turbopack: {
    root: process.cwd(),
  },
  outputFileTracingRoot: process.cwd(),
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

  // La CSP dinámica con nonce se genera en proxy.js. El resto de cabeceras de
  // producción las aplica Caddy una sola vez, también a los assets estáticos.
  async headers() {
    return ['/api/fixtures', '/api/match/:id', '/api/baseball/fixtures', '/api/baseball/match/:id', '/api/sports/:sport/fixtures', '/api/sports/:sport/match/:id', '/api/auth/session', '/api/realtime/token', '/api/free/visit'].map(source => ({ source, headers: [{ key: 'Cache-Control', value: 'private, no-store' }] }));
  },
};

export default nextConfig;
