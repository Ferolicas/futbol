import LegalDocument from '../../components/LegalDocument';

export const metadata = { title: 'Privacidad y tratamiento de datos | CF Análisis' };

export default function PrivacyPage() {
  return (
    <LegalDocument eyebrow="Protección de datos" title="Política de privacidad y tratamiento">
      <section>
        <h2>1. Responsable</h2>
        <p>El responsable es <strong>Ferney Oliveros</strong>, con domicilio informado en Medellín, Colombia, correo <a href="mailto:info@cfanalisis.com">info@cfanalisis.com</a>. Esta política aplica a CF Análisis web y móvil.</p>
      </section>
      <section>
        <h2>2. Datos tratados</h2>
        <p>Tratamos nombre, correo, credenciales protegidas mediante hash, sesiones y datos técnicos de seguridad; plan, estado e identificadores de pago; preferencias de cuenta, zona horaria, soporte y evidencia de aceptación. Los proveedores de pago pueden tratar los datos financieros y de facturación que les entregas; CF Análisis no almacena el número completo de tu tarjeta.</p>
      </section>
      <section>
        <h2>3. Finalidades y bases</h2>
        <ul>
          <li>Crear y autenticar la cuenta, prestar el servicio y administrar pagos: ejecución del contrato.</li>
          <li>Prevenir fraude, abuso y accesos indebidos: interés legítimo y seguridad.</li>
          <li>Cumplir obligaciones contables, fiscales, de consumo y protección de datos: obligación legal.</li>
          <li>Responder soporte y ejercer o defender reclamaciones.</li>
          <li>Tratar datos con la autorización expresa exigida por la legislación colombiana.</li>
        </ul>
        <p><strong>No vendemos, alquilamos ni entregamos bases de usuarios para publicidad de terceros.</strong> La aceptación de estos documentos no autoriza correos promocionales. Avisos indispensables sobre seguridad, pagos, cambios contractuales o funcionamiento sí pueden enviarse. Descuentos y promociones requieren una preferencia separada y revocable cuando la ley lo exija.</p>
      </section>
      <section>
        <h2>4. Destinatarios y encargados</h2>
        <p>Usamos proveedores estrictamente necesarios: infraestructura de servidor y copias de seguridad; Stripe y Mercado Pago para pagos; Resend o ZeptoMail para correo; y proveedores técnicos de datos deportivos. Solo reciben lo necesario para su función y pueden estar sujetos a sus propias políticas y obligaciones legales.</p>
      </section>
      <section>
        <h2>5. Transferencias internacionales y Europa</h2>
        <p>El responsable está en Colombia y presta el servicio por internet. Algunos encargados operan en otros países. Cuando el RGPD sea aplicable se utilizará el mecanismo válido que corresponda y se informará sobre las garantías disponibles. CF Análisis no afirma que Colombia tenga una decisión general de adecuación de la Unión Europea.</p>
        <p>Al ofrecer servicios de forma habitual a personas en la Unión Europea puede resultar obligatoria la designación de un representante conforme al artículo 27 del RGPD. Mientras esa designación se formaliza, las solicitudes se reciben directamente en <a href="mailto:info@cfanalisis.com">info@cfanalisis.com</a>; esto no limita el derecho a acudir a una autoridad europea de control.</p>
      </section>
      <section>
        <h2>6. Conservación</h2>
        <p>La cuenta y el perfil se conservan mientras exista la cuenta y durante los plazos legales posteriores. Pagos, webhooks y evidencia contractual se conservan durante los plazos fiscales, contractuales o de defensa aplicables. Las sesiones expiradas se eliminan periódicamente; logs operativos tienen un objetivo de 14 días, métricas técnicas 30 días y copias operativas rotan entre la copia diaria actual y la anterior válida, salvo retención legal o incidente.</p>
      </section>
      <section>
        <h2>7. Derechos</h2>
        <p>Puedes solicitar acceso, actualización, rectificación, supresión, portabilidad cuando aplique, oposición, limitación, revocación de autorizaciones y prueba de la autorización. La revocación no afecta tratamientos necesarios para ejecutar el contrato ni obligaciones legales. Escribe desde el correo de tu cuenta a <a href="mailto:info@cfanalisis.com">info@cfanalisis.com</a>. Podremos verificar tu identidad sin pedir más datos de los necesarios.</p>
        <p>También puedes reclamar ante la <a href="https://www.sic.gov.co/" target="_blank" rel="noreferrer">SIC de Colombia</a> o, si te encuentras en el EEE, ante la autoridad de protección de datos de tu país.</p>
      </section>
      <section>
        <h2>8. Seguridad y menores</h2>
        <p>Aplicamos controles de acceso, hash de contraseñas, sesiones revocables, cifrado en tránsito, minimización y registros de seguridad. Ningún sistema es infalible. El servicio no está dirigido a menores de 18 años; si detectamos una cuenta de un menor, procederemos conforme a la ley.</p>
      </section>
    </LegalDocument>
  );
}
