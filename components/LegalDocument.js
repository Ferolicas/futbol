import Link from 'next/link';
import BrandLogoMedia from './BrandLogoMedia';

export default function LegalDocument({ title, eyebrow, children }) {
  return (
    <main className="legal-page">
      <header className="legal-header">
        <Link href="/" aria-label="Volver a CF Análisis">
          <BrandLogoMedia className="legal-logo" animated={false} />
        </Link>
        <p>{eyebrow}</p>
        <h1>{title}</h1>
        <span>Versión vigente: 3 de octubre de 2026</span>
      </header>
      <article className="legal-content">{children}</article>
      <footer className="legal-footer">
        <Link href="/terminos">Términos</Link>
        <Link href="/privacidad">Privacidad</Link>
        <Link href="/cookies">Cookies</Link>
        <Link href="/preferencias/comunicaciones">Comunicaciones</Link>
        <Link href="/">Volver al inicio</Link>
      </footer>
    </main>
  );
}
