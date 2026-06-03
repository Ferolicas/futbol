import './globals.css';
import Providers from '../components/providers';

export const metadata = {
  title: 'CF Analisis - Futbol',
  description: 'Plataforma avanzada de analisis de futbol y apuestas deportivas. Estadisticas, combinadas inteligentes, marcadores en vivo.',
  keywords: 'futbol, apuestas, analisis, estadisticas, combinadas, probabilidades',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'CFanalisis',
  },
  // Equivalente estándar (Chrome/Android) del apple-mobile-web-app-capable.
  // Chrome avisa que el meta apple-* está deprecado y pide este también.
  other: { 'mobile-web-app-capable': 'yes' },
  icons: {
    icon: '/icon-192.png',
    apple: [
      { url: '/apple-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#00e676',
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
