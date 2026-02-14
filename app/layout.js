import './globals.css';

export const metadata = {
  title: 'Futbol Analysis - Partidos del Dia',
  description: 'Analisis de partidos de futbol con estadisticas, H2H, cuotas y mas',
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
