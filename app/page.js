// CF Análisis es ahora una herramienta de uso personal. La raíz no ofrece
// registro, planes ni enlaces: responde como una página inexistente (404). La
// aplicación se abre escribiendo /dashboard, que pide iniciar sesión.
import { notFound } from 'next/navigation';

export const metadata = { robots: { index: false, follow: false } };

export default function RootPage() {
  notFound();
}
