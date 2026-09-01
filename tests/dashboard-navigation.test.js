const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('el header queda reducido a chat, logo centrado y búsqueda Spotlight', () => {
  const header = read('app/dashboard/components/DashboardHeader.js');
  const spotlight = read('app/dashboard/components/AppleSpotlightSearch.js');
  assert.match(header, /<BrandLogoMedia \/>/);
  assert.match(header, /<ChatWidget \/>/);
  assert.match(header, /<AppleSpotlightSearch \/>/);
  assert.doesNotMatch(header, /SportToggle|dashboard-account|initialUser/);
  assert.match(spotlight, /createPortal\(overlay, document\.body\)/);
  assert.match(spotlight, /selectedSports\.length\) params\.set\('sports'/);
  assert.match(spotlight, /Sin ningún deporte seleccionado, buscaremos en toda la app/);
  assert.match(spotlight, /className="spotlight-launchers"/);
  assert.match(spotlight, /layout=!\{?reduceMotion|layout=\{!reduceMotion\}/);
  assert.match(spotlight, /SPOTLIGHT_SPRING/);
  const styles = read('app/globals.css');
  assert.match(styles, /\.dashboard-brand \{[\s\S]*width: 37\.8% !important/);
  const logo = read('components/BrandLogoMedia.js');
  assert.match(logo, /logo-metalizado-alpha\.avif\?v=2/);
  assert.doesNotMatch(logo, /logo-metalizado-fast\.webm|brand-logo-alpha-video/);
});

test('el chat ocupa la pantalla y se minimiza hacia su botón con movimiento reducido seguro', () => {
  const chat = read('app/dashboard/chat-widget.js');
  assert.match(chat, /createPortal\(panel, document\.body\)/);
  assert.match(chat, /className="chat-fullscreen"/);
  assert.match(chat, /clipPath:\s*\[/);
  assert.match(chat, /circle\(0px at \$\{origin\.x\}px \$\{origin\.y\}px\)/);
  assert.match(chat, /initial=\{false\}/);
  assert.doesNotMatch(chat, /animationState|scaleX:\s*\.055|filter:\s*'blur\(3px\)'/);
  assert.match(chat, /useReducedMotion\(\)/);
  assert.match(chat, /aria-label="Minimizar chat"/);
});

test('la búsqueda normaliza acentos, valida deportes y crea rutas correctas', async () => {
  const {
    dashboardSearchHref,
    normalizeDashboardSearchQuery,
    parseDashboardSearchSports,
  } = await import('../lib/dashboard-search.js');

  assert.equal(normalizeDashboardSearchQuery('  Atlético   Nacional  '), 'atletico nacional');
  assert.deepEqual(parseDashboardSearchSports(''), ['football', 'baseball', 'basketball', 'american_football']);
  assert.deepEqual(parseDashboardSearchSports('basketball,basketball,invalid'), ['basketball']);
  assert.equal(dashboardSearchHref('football', 42), '/dashboard/analisis/42');
  assert.equal(dashboardSearchHref('american_football', 'nfl 7'), '/dashboard/futbol-americano/analisis/nfl%207');
});

test('la tira de jornadas contiene mañana, hoy y diez días anteriores', () => {
  const filters = read('app/dashboard/components/DashboardFilters.js');
  assert.match(filters, /Array\.from\(\{ length: 12 \}, \(_, index\) => shiftIsoDay\(today, 1 - index\)\)/);
  assert.match(filters, /className=\{`dashboard-date-tile \$\{isToday \? 'is-today'/);
  assert.match(filters, /data-selected=\{isSelected \? 'true' : 'false'\}/);
  assert.match(filters, /const WEEKDAYS = \['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'\]/);
  const styles = read('app/globals.css');
  assert.match(styles, /\.dashboard-date-tile\[data-selected="true"\][\s\S]*linear-gradient\(145deg, #7af0c5, #36d99e\)/);
  assert.match(styles, /\.dashboard-date-tile\[data-selected="false"\][\s\S]*background: rgba\(255,255,255,\.025\) !important/);
});

test('los cuatro dashboards usan el dock fijo con En vivo en el centro', () => {
  const filters = read('app/dashboard/components/DashboardFilters.js');
  const football = read('app/dashboard/page.js');
  const baseball = read('app/dashboard/baseball/page.js');
  const multisport = read('app/dashboard/components/MultisportDashboard.js');
  assert.match(filters, /\{ key: 'live', label: 'En vivo', icon: RadioTower, count: counts\.live, live: true \}/);
  assert.match(filters, /\{ key: 'favoritos', label: 'Favoritos'/);
  assert.match(football, /<DashboardStatusDock/);
  assert.match(baseball, /<DashboardStatusDock/);
  assert.match(multisport, /<DashboardStatusDock/);
  assert.match(multisport, /window\.localStorage\.setItem\(`cf:\$\{sport\}:favorites`/);
});

test('la combinada se integra en Favoritos y desaparecen las pestañas duplicadas', () => {
  const football = read('app/dashboard/page.js');
  const baseball = read('app/dashboard/baseball/page.js');
  const multisport = read('app/dashboard/components/MultisportDashboard.js');

  for (const source of [football, baseball, multisport]) {
    assert.doesNotMatch(source, /className="tabs/);
    assert.doesNotMatch(source, /setTab\(/);
    assert.match(source, /statusFilter === 'favoritos'/);
    assert.match(source, /favorites-combination-hub/);
  }
});

test('cada combinada guardada conserva el encabezado de los equipos por partido', () => {
  const football = read('app/dashboard/page.js');
  const styles = read('app/globals.css');

  assert.match(football, /groupSavedCombinadaSelections\(comb\.selections\)/);
  assert.match(football, /className="saved-comb-match-head"/);
  assert.match(football, /<strong>\{match\.matchName\}<\/strong>/);
  assert.match(styles, /\.saved-comb-match-head \{/);
});

test('Apuesta del día usa cabecera fija y tarjetas compactas con desplazamiento horizontal', () => {
  const football = read('app/dashboard/page.js');
  const baseball = read('app/dashboard/baseball/page.js');
  const multisport = read('app/dashboard/components/MultisportDashboard.js');
  const styles = read('app/globals.css');
  assert.match(football, /className="daily-pick-rail"/);
  assert.match(baseball, /className="daily-pick-rail"/);
  assert.match(football, /className="daily-pick-heading"/);
  assert.match(baseball, /className="daily-pick-heading"/);
  assert.match(football, /daily-pick-sticker\.webp/);
  assert.match(baseball, /daily-pick-sticker\.webp/);
  for (const source of [football, baseball, multisport]) {
    assert.match(source, /resolveDailyPickView\(preferredView, picks\.length, results\.length\)/);
    assert.match(source, /<span>Resultados<\/span>/);
  }
  assert.doesNotMatch(football, /className="daily-pick-title-card"/);
  assert.doesNotMatch(baseball, /className="daily-pick-title-card"/);
  assert.match(styles, /\.daily-pick-track[\s\S]*overflow-x: auto/);
  assert.match(styles, /scroll-snap-type: x proximity/);
});

test('el dock inferior llega al borde y el header tapa el contenido al hacer scroll', () => {
  const styles = read('app/globals.css');
  assert.match(styles, /\.dashboard-status-dock \{[\s\S]*bottom: 0 !important/);
  assert.match(styles, /height: calc\(67px \+ env\(safe-area-inset-bottom\)\) !important/);
  assert.match(styles, /\.dashboard-topbar \{[\s\S]*#040e14 !important/);
});

test('liga y deporte conservan media fila pero sus listas se abren más anchas', () => {
  const styles = read('app/globals.css');
  assert.match(styles, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important/);
  assert.match(styles, /dashboard-picker:first-child \.dashboard-picker-menu,[\s\S]*width: calc\(200% \+ var\(--dashboard-filter-gap\)\) !important/);
  assert.match(styles, /dashboard-picker:last-child \.dashboard-picker-menu,[\s\S]*width: calc\(150% \+ var\(--dashboard-filter-half-gap\)\) !important/);
  assert.match(styles, /\.app \.controls-row,[\s\S]*grid-template-columns: minmax\(0, 1fr\) !important/);
});
