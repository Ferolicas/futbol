# CF Análisis — sistema visual

Actualizado: 2026-07-29

## Dirección

Producto móvil primero, oscuro y orientado a datos. La identidad combina superficies azul petróleo casi negras, acento verde menta y profundidad contenida. El elemento firma es el video-logo metalizado transparente, acompañado por halos verdes suaves y una retícula de baja opacidad.

## Tokens principales

- Fondo: `#03090f`.
- Superficie: `rgba(10,22,29,.82)`.
- Superficie fuerte: `rgba(13,29,37,.96)`.
- Texto: `#edf6f4`.
- Texto secundario: `#8fa1aa`.
- Acción/acento: `#5ee6b1`.
- Borde: `rgba(255,255,255,.085)`.
- Error: `#fb7185`.

Fútbol y Baseball comparten la misma identidad verde menta. El ámbar queda
reservado exclusivamente para estados semánticos de advertencia o riesgo, no
para diferenciar deportes.

La tipografía principal es Plus Jakarta Sans y los números/datos usan JetBrains Mono. Ambas se sirven con `next/font`.

## Componentes

- Home y planes: escenas fijas controladas por scroll, teclado o swipe. La pantalla no acumula secciones verticales.
- Header autenticado: video-logo, selector desplegable de deporte y menú de avatar. Se adapta desde 320 px y permanece visible.
- Controles: jornada y competición comparten siempre una sola fila. Las opciones mantienen texto claro sobre fondo oscuro.
- Navegación del dashboard: orden fijo `Partidos → Combinada → Estado`.
- Tabs y chips: estado activo con color, borde y fondo; nunca dependen solo del color.
- Tarjetas: una sola capa de profundidad, sin `backdrop-filter` ni animaciones de sombra repetidas por tarjeta.
- Checkout: hoja inferior en móvil y modal centrado en escritorio. Stripe y Mercado Pago comparten la misma carcasa visual.
- Modal de análisis: escenario fijo sin paginación ni flechas. Rueda, teclado y
  swipe capturados desde el conductor controlan las capas en el mismo viewport;
  cuando no queda contenido interno por recorrer, cada gesto de rueda/trackpad
  o pulsación de navegación cambia una sola escena;
  las escenas permanecen nítidas, sin blur ni escalado, y solo el contenido que
  excede la altura conserva scroll interno.
- Cargas: skeleton de superficie. `BrandLogoMedia` utiliza un VP9 optimizado
  con alfa real en Chromium y una imagen WebP estática transparente en
  WebKit/iOS o movimiento reducido.

## Motion y rendimiento

- Interacciones táctiles: 150–220 ms.
- Cambios de escena del análisis: fundido nítido de 120–180 ms, sin escalado.
- El scroll de Home y planes se desbloquea a los 110 ms para aceptar gestos rápidos.
- Solo los estados realmente en vivo pueden mantener un pulso continuo.
- `prefers-reduced-motion` elimina transiciones y animaciones no esenciales.
- Las rutas `/dashboard` y `/dashboard/baseball` se precargan desde el selector deportivo.
- Las transiciones del análisis responden al gesto y respetan
  `prefers-reduced-motion`; la inercia de un trackpad se agrupa como un único
  gesto, sin introducir una espera perceptible entre gestos consecutivos.

## Responsive

La referencia primaria es 390 × 844. La composición debe seguir funcionando desde 320 px de ancho y en alturas cortas de 640 px sin desbordamiento horizontal. Escritorio amplía el ancho y el espaciado, pero no altera la jerarquía móvil.
