import LegalDocument from '../../components/LegalDocument';

export const metadata = { title: 'Términos y condiciones | CF Análisis' };

export default function TermsPage() {
  return (
    <LegalDocument eyebrow="Información contractual" title="Términos y condiciones">
      <section>
        <h2>1. Responsable del servicio</h2>
        <p>CF Análisis es operado por <strong>Ferney Elpidio Oliveros Casanova</strong>, NIT <strong>1143978081</strong>, con domicilio legal informado en Medellín, Colombia. Contacto: <a href="mailto:info@cfanalisis.com">info@cfanalisis.com</a>. El único sitio oficial es <strong>cfanalisis.com</strong>.</p>
        <p>No solicitamos contraseñas, códigos de verificación, firmas, documentos escaneados ni pagos por mensajes privados. Los pagos se realizan únicamente mediante Stripe o Mercado Pago dentro del flujo oficial.</p>
      </section>
      <section>
        <h2>2. Servicio y edad mínima</h2>
        <p>La plataforma ofrece estadísticas, modelos y análisis informativos de fútbol, béisbol, baloncesto y fútbol americano. No es una casa de apuestas, no custodia dinero para apostar y no garantiza ganancias ni resultados. El servicio está dirigido exclusivamente a personas mayores de 18 años o la mayoría de edad superior que corresponda en su país.</p>
      </section>
      <section>
        <h2>3. Cuenta</h2>
        <p>Debes proporcionar información veraz, proteger tus credenciales y avisar de accesos no autorizados. No puedes suplantar identidades, usar nombres ofensivos, automatizar abusivamente el servicio, vulnerar controles de acceso ni revender el contenido.</p>
      </section>
      <section>
        <h2>4. Plan Free y suscripciones</h2>
        <p>Una cuenta sin derecho de pago vigente funciona como plan Free. Los planes semanal, mensual, trimestral, semestral y anual duran el periodo mostrado antes de comprar. Solo se activa Pro después de que el proveedor confirme el pago.</p>
        <p>Las suscripciones recurrentes se renuevan por el mismo periodo y precio informado en el checkout, salvo cambio comunicado conforme a la ley. Si una renovación falla, la cuenta pasa inmediatamente a Free; el proveedor puede seguir reintentando el cobro y un pago posterior confirmado reactiva el plan. Puedes cancelar la renovación desde la plataforma; conservarás únicamente el periodo ya pagado que siga vigente.</p>
      </section>
      <section>
        <h2>5. Precios, pagos y comprobantes</h2>
        <p>Antes de confirmar se muestra el precio total, moneda, periodicidad y proveedor. Stripe procesa pagos fuera de Colombia y Mercado Pago procesa pagos en Colombia. CF Análisis no almacena números completos de tarjeta. Conservamos evidencia contractual y transaccional durante los plazos legales aplicables.</p>
      </section>
      <section>
        <h2>6. Desistimiento, retracto y reembolsos</h2>
        <p>Se respetan los derechos irrenunciables del país del consumidor. Si resides en la Unión Europea, normalmente puedes desistir de un contrato a distancia durante 14 días. Si solicitas que el servicio comience de inmediato, podrá descontarse el valor proporcional del servicio efectivamente prestado cuando la ley lo permita. Para ejercerlo escribe a <a href="mailto:info@cfanalisis.com">info@cfanalisis.com</a> indicando cuenta, fecha y compra.</p>
        <p>En Colombia se aplican el retracto, la reversión del pago y las excepciones legalmente vigentes. Nada en estos términos limita una garantía o derecho obligatorio. Las devoluciones aprobadas se realizan por el mismo medio de pago cuando sea posible.</p>
      </section>
      <section>
        <h2>7. Disponibilidad y propiedad intelectual</h2>
        <p>Podemos realizar mantenimiento y corregir errores. Las marcas, interfaz, modelos, textos y compilaciones pertenecen a su titular o licenciantes. Se concede una licencia personal, limitada, revocable y no transferible mientras tu cuenta esté habilitada.</p>
      </section>
      <section>
        <h2>8. Responsabilidad</h2>
        <p>Toda decisión de apuesta es personal y conlleva riesgo de pérdida. Verifica cuotas, reglas y restricciones del operador que elijas. No se excluye responsabilidad que legalmente no pueda excluirse, ni se reducen derechos obligatorios de consumidores.</p>
      </section>
      <section>
        <h2>9. Cambios y ley aplicable</h2>
        <p>Los cambios materiales se informarán y, cuando corresponda, se solicitará una nueva aceptación. Rige la ley colombiana sin privar a consumidores europeos ni de otros países de sus protecciones imperativas. Puedes presentar una reclamación ante la <a href="https://www.sic.gov.co/" target="_blank" rel="noreferrer">Superintendencia de Industria y Comercio</a> o la autoridad competente de tu residencia.</p>
      </section>
    </LegalDocument>
  );
}
