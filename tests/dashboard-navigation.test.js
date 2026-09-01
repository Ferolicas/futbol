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
  assert.match(spotlight, /Sin filtro deportivo, buscaremos en toda la app/);
});

test('el chat ocupa la pantalla y se minimiza hacia su botón con movimiento reducido seguro', () => {
  const chat = read('app/dashboard/chat-widget.js');
  assert.match(chat, /createPortal\(panel, document\.body\)/);
  assert.match(chat, /className="chat-fullscreen"/);
  assert.match(chat, /clipPath:\s*\[/);
  assert.match(chat, /scaleX:\s*\[1, \.48, \.055\]/);
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
  assert.match(filters, /const WEEKDAYS = \['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'\]/);
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
