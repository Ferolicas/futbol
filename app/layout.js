import './globals.css';

export const metadata = {
  title: 'Futbol Analysis - Betting Analysis Dashboard',
  description: 'Análisis estadístico de partidos de fútbol: H2H, probabilidades, cuotas, combinadas automáticas',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
