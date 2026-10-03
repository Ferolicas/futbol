import LegalDocument from '../../components/LegalDocument';

export const metadata = { title: 'Política de cookies | CF Análisis' };

export default function CookiesPage() {
  return (
    <LegalDocument eyebrow="Tecnologías del sitio" title="Política de cookies">
      <section>
        <h2>1. Uso actual</h2>
        <p>CF Análisis usa la cookie <strong>__Host-cf_session</strong>, estrictamente necesaria para mantener la sesión autenticada de forma segura. Es HttpOnly, Secure y SameSite=Lax; el código del navegador no puede leerla. Su duración máxima es de 30 días para usuarios y de 12 horas para cuentas administrativas, y puede finalizar antes al cerrar sesión o revocar la sesión.</p>
      </section>
      <section>
        <h2>2. Almacenamiento local necesario</h2>
        <p>La web y la app pueden usar almacenamiento local o de sesión para recordar ajustes técnicos, zona horaria, estado visual, intentos de pago seguros y que ya viste el aviso de cookies. Estos valores no se utilizan para crear perfiles publicitarios.</p>
      </section>
      <section>
        <h2>3. Proveedores de pago</h2>
        <p>Stripe o Mercado Pago pueden establecer tecnologías propias cuando abres su formulario, necesarias para seguridad, prevención de fraude y procesamiento del pago. Consulta sus políticas en el propio checkout.</p>
      </section>
      <section>
        <h2>4. Sin cookies publicitarias</h2>
        <p>No usamos actualmente cookies de publicidad, seguimiento entre sitios ni analítica opcional. Por eso no mostramos una falsa opción de rechazarlas: las tecnologías propias de CF Análisis son necesarias para prestar el servicio. Si incorporamos tecnologías opcionales, estarán desactivadas hasta obtener el consentimiento exigido y se ofrecerá un control para retirarlo.</p>
      </section>
      <section>
        <h2>5. Control del navegador</h2>
        <p>Puedes borrar o bloquear cookies desde tu navegador, pero bloquear la cookie esencial impedirá iniciar o mantener la sesión. Para preguntas escribe a <a href="mailto:info@cfanalisis.com">info@cfanalisis.com</a>.</p>
      </section>
    </LegalDocument>
  );
}
