/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Diagnóstico con DATO REAL de API-Football. Vuelca TODOS los bets (id + nombre +
// nº values + ejemplos) que ofrece cada bookmaker autorizado para un fixture, y
// marca cuáles NO están mapeados en BET_NAMES (= mercados ricos que se pierden).
// Sirve para identificar, con el catálogo real, qué bets agregar al extractor.
//
//   node --env-file=.env scripts/diagnose-odds-raw.js 1545409
//   node --env-file=.env scripts/diagnose-odds-raw.js 1545409 bet365
// ────────────────────────────────────────────────────────────────────────
try { require('dotenv').config({ path: '.env.local' }); } catch {}
try { require('dotenv').config({ path: '.env' }); } catch {}

const API_HOST = 'v3.football.api-sports.io';
const KEY = process.env.FOOTBALL_API_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
const fixtureId = process.argv[2];
const bkFilter = (process.argv[3] || '').toLowerCase();

const ALLOWED = ['bet365', 'bwin'];
const normBk = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s.\-_]/g, '');
const isAllowed = (name) => { const n = normBk(name); return ALLOWED.find(a => n.includes(a)) || null; };

// Espejo de BET_NAMES (lib/api-football.js) — para marcar qué bets YA están mapeados.
const BET_NAMES = {
  matchWinner: ['Match Winner', 'Full Time Result', '1X2'],
  overUnder: ['Goals Over/Under', 'Over/Under', 'Total Goals', 'Goal Line'],
  btts: ['Both Teams Score', 'Both Teams To Score'],
  cornersTotal: ['Total - Corners', 'Corners Over Under', 'Corners Over/Under', 'Total Corners', 'Corners 2-Way', 'Total Corners (3 way)', 'Total Corners (2 way)'],
  cardsTotal: ['Total - Cards', 'Cards Over Under', 'Cards Over/Under', 'Total Cards', 'Total Bookings'],
  homeCorners: ['Total Corners - Home', 'Home Team Total Corners', 'Home Corners Over/Under', 'Home Team Corners'],
  awayCorners: ['Total Corners - Away', 'Away Team Total Corners', 'Away Corners Over/Under', 'Away Team Corners'],
  homeCards: ['Total Bookings - Home', 'Home Team Cards', 'Home Cards Over/Under', 'Home Team Bookings', 'Home Team Total Cards'],
  awayCards: ['Total Bookings - Away', 'Away Team Cards', 'Away Cards Over/Under', 'Away Team Bookings', 'Away Team Total Cards'],
  homeGoals: ['Home Total Goals', 'Home Team Total Goals', 'Total - Home', 'Home Team Goals Over/Under'],
  awayGoals: ['Away Total Goals', 'Away Team Total Goals', 'Total - Away', 'Away Team Goals Over/Under'],
  shotsTotal: ['Total Shots'], sotTotal: ['Total ShotOnGoal', 'Total Shots On Target'],
  foulsTotal: ['Fouls. Total', 'Total Fouls'],
  goalsOu1H: ['Goals Over/Under First Half'], goalsOu2H: ['Goals Over/Under - Second Half'],
  cornersTotal1H: ['Total Corners (1st Half)'], cornersTotal2H: ['Total Corners (2nd Half)'],
  scorer: ['Anytime Goal Scorer', 'Anytime Goalscorer', 'Player Anytime Goalscorer', 'Anytime Scorer', 'Home Anytime Goal Scorer', 'Away Anytime Goal Scorer'],
};
const ALL_MAPPED = new Set(Object.values(BET_NAMES).flat());
const familyOf = (name) => { for (const [fam, list] of Object.entries(BET_NAMES)) if (list.includes(name)) return fam; return null; };
// ¿El nombre sugiere un mercado de LÍNEAS que nos interesa? (para resaltar lo no mapeado)
const looksRich = (name) => /corner|card|booking|goal|shot|foul|over|under|total|line|handicap/i.test(name);

(async () => {
  if (!KEY) { console.error('Falta FOOTBALL_API_KEY.'); process.exit(1); }
  if (!fixtureId) { console.error('Uso: node scripts/diagnose-odds-raw.js <fixtureId> [bookmaker]'); process.exit(1); }

  const res = await fetch(`https://${API_HOST}/odds?fixture=${fixtureId}`, { headers: { 'x-apisports-key': KEY } });
  const json = await res.json();
  const bookmakers = json?.response?.[0]?.bookmakers || [];
  console.log(`\nfixture ${fixtureId} · bookmakers en respuesta: ${bookmakers.length}`);
  if (json?.errors && Object.keys(json.errors).length) console.log('errors:', JSON.stringify(json.errors));

  for (const bk of bookmakers) {
    const allowedAs = isAllowed(bk.name);
    if (bkFilter ? !normBk(bk.name).includes(normBk(bkFilter)) : !allowedAs) continue;
    const bets = bk.bets || [];
    console.log(`\n══ ${bk.name} (id=${bk.id}) ${allowedAs ? `[autorizada: ${allowedAs}]` : '[NO autorizada]'} · ${bets.length} mercados ══`);

    const mapped = [], unmappedRich = [], other = [];
    for (const bet of bets) {
      const fam = familyOf(bet.name);
      const row = `  id=${String(bet.id).padStart(3)} "${bet.name}" (${(bet.values || []).length} values)`;
      if (fam) mapped.push(`${row}  → ${fam}`);
      else if (looksRich(bet.name)) unmappedRich.push(`${row}  ✗ SIN MAPEAR · ej: ${(bet.values || []).slice(0, 4).map(v => `${v.value}=${v.odd}`).join(' | ')}`);
      else other.push(row);
    }
    console.log(` ── MAPEADOS (${mapped.length}) ──`);
    mapped.forEach(r => console.log(r));
    console.log(` ── RICOS SIN MAPEAR (${unmappedRich.length}) — candidatos a agregar a BET_NAMES ──`);
    unmappedRich.forEach(r => console.log(r));
    console.log(` ── OTROS (${other.length}) ──`);
    other.slice(0, 12).forEach(r => console.log(r));
    if (other.length > 12) console.log(`   …(+${other.length - 12} más)`);
  }
  console.log('\nLeyenda: "RICOS SIN MAPEAR" = bets de líneas (corners/goles/tarjetas/etc.) que el');
  console.log('extractor IGNORA porque su nombre no está en BET_NAMES. Pásame esa lista y los agrego.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
