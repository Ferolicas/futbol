// Única pantalla pública del sitio: la raíz y cualquier dirección que no sea
// la aplicación muestran este aviso, sin enlaces ni promesa de regreso.

export const metadata = {
  title: 'Página no encontrada',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, background: '#03090f', color: '#edf6f4', textAlign: 'center',
      }}
    >
      <p style={{ margin: 0, fontSize: 'clamp(1.25rem, 4vw, 1.9rem)', fontWeight: 600, letterSpacing: '.01em' }}>
        Esta página no existe
      </p>
    </main>
  );
}
