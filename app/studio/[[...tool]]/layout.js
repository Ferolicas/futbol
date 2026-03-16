export const metadata = {
  title: 'CFanalisis Studio',
  description: 'Sanity Studio - CFanalisis',
};

export default function StudioLayout({ children }) {
  return (
    <html lang="es">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
