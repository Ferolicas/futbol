import './globals.css';

export const metadata = {
  title: 'CFanalisis.com - Analisis de Futbol',
  description: 'Analisis estadistico de partidos de futbol: H2H, probabilidades, cuotas, combinadas automaticas',
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
