/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output: copia solo el bundle minimo necesario + node_modules
  // de dependencias usadas a .next/standalone/. Permite arrancar la app con
  // `node .next/standalone/server.js` en cualquier host (VPS, Docker, etc.)
  // sin necesidad de instalar el package.json completo en produccion.
  output: 'standalone',

  images: {
    unoptimized: true,
  },

  env: {
    NEXT_PUBLIC_PUSHER_KEY: '4b69ba2ea5a71be0e991',
    NEXT_PUBLIC_PUSHER_CLUSTER: 'sa1',
    NEXT_PUBLIC_VAPID_KEY: process.env.VAPID_PUBLIC_KEY || '',
  },
};

export default nextConfig;
