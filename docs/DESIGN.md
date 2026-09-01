# CF Análisis — sistema visual

Actualizado: 2026-09-01

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
- Header autenticado: muestra `Chat` a la izquierda, el video-logo centrado al
  54% del ancho y `Buscar` a la derecha. La búsqueda abre un Spotlight de pantalla
  completa sobre el mismo fondo de la app. Primero presenta la cápsula compacta y
  cuatro accesos deportivos circulares de la referencia Apple; al enfocar, la misma
  superficie crece con física spring y lista los resultados. Admite filtros
  combinables y, sin ninguno activo, consulta los cuatro deportes.
- Jornadas: tira horizontal compacta desde mañana hasta diez días atrás. Cada
  tarjeta muestra abreviatura del día y `número + mes`. El verde sólido pertenece
  exclusivamente a la jornada seleccionada; hoy no conserva un segundo indicador
  cuando el usuario consulta otra fecha.
- Estados: dock inferior de cinco accesos `Hoy → Próximos → En vivo →
  Finalizados → Favoritos`. `En vivo` ocupa el centro, sobresale como círculo
  rojo de transmisión y mantiene un pulso leve; el dock deja espacio seguro a
  las acciones flotantes y al gesto inferior del sistema.
- Chat: el acceso vive en el header y abre soporte en toda la pantalla. Al
  abrir, la pantalla opaca aparece directamente y el contenido entra de forma
  breve, sin miniaturas oscuras ni capas translúcidas intermedias. Al minimizar,
  la superficie se contrae hacia el propio botón con una curva tipo ventana de
  macOS; movimiento reducido reemplaza el gesto por un cambio instantáneo.
- Identidad instalada: favicon, acceso de Android y acceso de iPhone usan el
  monograma cuadrado CF verde/ámbar sobre negro. Sus rutas PWA son versionadas
  para invalidar la caché del icono anterior; el logo horizontal animado se
  conserva dentro de la interfaz.
- Controles: jornada y competición forman un bloque vertical compacto de ancho
  completo. El filtro
  de ligas de fútbol conserva el menú abierto, usa checkboxes reales y ofrece
  acciones compactas “Todas”/“Ninguna”; la selección se guarda automáticamente.
  Los disparadores de Liga y Deporte comparten la fila al 50%; únicamente sus
  menús crecen al abrirse. Liga usa el ancho completo de la fila y Deporte un
  75% alineado a la derecha. Las opciones mantienen texto claro sobre fondo oscuro.
- Navegación del dashboard: no existen pestañas redundantes de Partidos/Combinada.
  Los partidos se gobiernan exclusivamente desde el dock inferior y el constructor
  de combinadas vive dentro de `Favoritos` en los cuatro deportes.
- Tabs y chips: estado activo con color, borde y fondo; nunca dependen solo del color.
- Tarjetas: una sola capa de profundidad, sin `backdrop-filter` ni animaciones de sombra repetidas por tarjeta.
- Constructor de combinadas: cada selección reserva una fila completa para
  partido/mercado y coloca probabilidad + cuota en una segunda fila estable;
  los títulos largos envuelven y nunca se truncan para hacer sitio a métricas.
- Apuesta del día: encabezado compacto inmóvil sobre el carrusel, con sticker
  metálico propio, nombre, cantidad de opciones y probabilidad media. Debajo se
  desplaza una tarjeta por selección; partido, mercado, probabilidad, fiabilidad
  disponible y cuota individual permanecen legibles al deslizar. `Resultados`
  conserva siempre su nombre y aspecto presionado cuando está activo. Si ya no
  queda ninguna selección próxima y existe al menos una en vivo o finalizada,
  esa vista se activa automáticamente para evitar una tira vacía.
- Terminología de mercados: la interfaz muestra `Más de` y `Menos de`. Los
  nombres históricos que todavía contengan `Over`, `Under` u `O/U` se traducen
  justo antes de renderizarse, sin alterar claves, cálculos ni datos del motor.
- Checkout: hoja inferior en móvil y modal centrado en escritorio. Stripe y Mercado Pago comparten la misma carcasa visual.
- Modal de análisis: documento vertical continuo, sin escenas, paginación ni
  revelado progresivo. Fútbol y Baseball mantienen todas sus secciones en el
  flujo normal del DOM y una sola superficie desplazable usa el scroll nativo
  del navegador para rueda, trackpad, teclado y gestos táctiles.
- Cargas: skeleton de superficie. `BrandLogoMedia` utiliza el AVIF animado con
  transparencia real en todos los navegadores compatibles y una imagen WebP
  estática transparente mientras carga, si falla o con movimiento reducido. Los
  WebM históricos no se sirven porque fueron codificados sin plano alfa.
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
- Informes privados: `/ferney/informes` sustituye la hoja interminable por un
  radar móvil de tarjetas desplegables. Cada partido ocupa una sola fila
  cerrada; al abrirlo aparecen familias compactas con probabilidad, fiabilidad,
  cuota cuando existe y una barra de intensidad. Fútbol/MLB comparten pestañas,
  fecha, buscador y filtros por familia y dirección. El orden interno nunca
  intercala líneas: `Más de` precede a `Menos de`. El CSV queda como descarga
  secundaria, no como interfaz principal.
- Jornadas largas: después de 520 px aparece el control flotante “Arriba” junto
  al botón de soporte. Usa icono Lucide, área táctil mínima de 48 px, foco
  visible y siempre salta de inmediato al encabezado; no anima el recorrido
  porque las listas virtualizadas muy largas pueden interrumpirlo al remedirse.

## Motion y rendimiento

- Interacciones táctiles: 150–220 ms.
- El scroll de Home y planes se desbloquea a los 110 ms para aceptar gestos rápidos.
- Solo los estados realmente en vivo pueden mantener un pulso continuo.
- `prefers-reduced-motion` elimina transiciones y animaciones no esenciales.
- El header del dashboard es completamente opaco y el dock inferior llega a
  `bottom: 0`; el safe-area del dispositivo se absorbe dentro de la superficie.
- El Spotlight replica el gesto cápsula → panel de Apple Spotlight, ofrece accesos
  circulares y búsqueda por equipo, liga o partido en Fútbol, Béisbol, Baloncesto
  y Fútbol americano.
- El modal de análisis no intercepta ni agrupa gestos: conserva la inercia y la
  respuesta nativas de cada navegador.

## Responsive

La referencia primaria es 390 × 844. La composición debe seguir funcionando desde 320 px de ancho y en alturas cortas de 640 px sin desbordamiento horizontal. Escritorio amplía el ancho y el espaciado, pero no altera la jerarquía móvil.
