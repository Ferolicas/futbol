# CF Análisis — sistema visual

Actualizado: 2026-08-16

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
- Identidad instalada: favicon, acceso de Android y acceso de iPhone usan el
  monograma cuadrado CF verde/ámbar sobre negro. Sus rutas PWA son versionadas
  para invalidar la caché del icono anterior; el logo horizontal animado se
  conserva dentro de la interfaz.
- Controles: jornada y competición comparten siempre una sola fila. El filtro
  de ligas de fútbol conserva el menú abierto, usa checkboxes reales y ofrece
  acciones compactas “Todas”/“Ninguna”; la selección se guarda automáticamente.
  Las opciones mantienen texto claro sobre fondo oscuro.
- Navegación del dashboard: orden fijo `Partidos → Combinada → Estado`.
- Tabs y chips: estado activo con color, borde y fondo; nunca dependen solo del color.
- Tarjetas: una sola capa de profundidad, sin `backdrop-filter` ni animaciones de sombra repetidas por tarjeta.
- Constructor de combinadas: cada selección reserva una fila completa para
  partido/mercado y coloca probabilidad + cuota en una segunda fila estable;
  los títulos largos envuelven y nunca se truncan para hacer sitio a métricas.
- Apuesta del día: partido y recomendación pueden ocupar tantas líneas como
  necesiten; probabilidad y cuota viven siempre debajo del texto, nunca encima
  ni a su derecha.
- Terminología de mercados: la interfaz muestra `Más de` y `Menos de`. Los
  nombres históricos que todavía contengan `Over`, `Under` u `O/U` se traducen
  justo antes de renderizarse, sin alterar claves, cálculos ni datos del motor.
- Checkout: hoja inferior en móvil y modal centrado en escritorio. Stripe y Mercado Pago comparten la misma carcasa visual.
- Modal de análisis: documento vertical continuo, sin escenas, paginación ni
  revelado progresivo. Fútbol y Baseball mantienen todas sus secciones en el
  flujo normal del DOM y una sola superficie desplazable usa el scroll nativo
  del navegador para rueda, trackpad, teclado y gestos táctiles.
- Cargas: skeleton de superficie. `BrandLogoMedia` utiliza un VP9 optimizado
  con alfa real en Chromium y una imagen WebP estática transparente en
  WebKit/iOS o movimiento reducido.
- Notificaciones en vivo: título `minuto · local marcador visitante` y una línea
  compacta por evento, con etiqueta española, jugador y equipo. El badge móvil
  es un CF monocromo; goles, anulaciones, penaltis, tarjetas, córners, remates y
  faltas tienen símbolos distintos. Sustituciones y VAR no relacionado con
  penalti no se notifican.
- Picks Premium de béisbol en Telegram: una única imagen horizontal 16:9 de
  3840×2160 por partido, con cabecera común de horario y abridores. Se entrega
  como documento PNG sin compresión para conservar la nitidez al ampliar. No existe un
  límite de cuatro tarjetas ni paginación: todas las tarjetas necesarias se
  reparten dinámicamente en filas y columnas. Cada tarjeta pertenece a una
  familia y contiene hasta seis opciones para conservar nombres y métricas.
  Probabilidad, fiabilidad y cuota usan respectivamente verde, cian y ámbar.
- Jornadas largas: después de 520 px aparece el control flotante “Arriba” junto
  al botón de soporte. Usa icono Lucide, área táctil mínima de 48 px, foco
  visible y siempre salta de inmediato al encabezado; no anima el recorrido
  porque las listas virtualizadas muy largas pueden interrumpirlo al remedirse.

## Motion y rendimiento

- Interacciones táctiles: 150–220 ms.
- El scroll de Home y planes se desbloquea a los 110 ms para aceptar gestos rápidos.
- Solo los estados realmente en vivo pueden mantener un pulso continuo.
- `prefers-reduced-motion` elimina transiciones y animaciones no esenciales.
- Las rutas `/dashboard` y `/dashboard/baseball` se precargan desde el selector deportivo.
- El modal de análisis no intercepta ni agrupa gestos: conserva la inercia y la
  respuesta nativas de cada navegador.

## Responsive

La referencia primaria es 390 × 844. La composición debe seguir funcionando desde 320 px de ancho y en alturas cortas de 640 px sin desbordamiento horizontal. Escritorio amplía el ancho y el espaciado, pero no altera la jerarquía móvil.
