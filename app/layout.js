import './globals.css';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import Providers from '../components/providers';

// FE-2: fuentes auto-hospedadas via next/font (reemplaza el @import render-blocking
// de Google Fonts). Mismos pesos que el @import previo. Expuestas como CSS vars
// para que globals.css las use con var(--font-*).
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-jakarta',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['500', '700'],
  display: 'swap',
  variable: '--font-mono',
});

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
    <html lang="es" className={`${jakarta.variable} ${jetbrainsMono.variable}`}>
      <body>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
