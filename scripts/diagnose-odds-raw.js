/* eslint-disable */
// ────────────────────────────────────────────────────────────────────────
// Diagnóstico con DATO REAL de API-Football (no sintético). Llama al endpoint
// /odds del fixture, vuelca CADA bet (id + nombre + values) que contenga
// "handicap" por bookmaker, y muestra cómo el classifyAH del extractor los
// enruta a full / 1H / 2H. Sirve para confirmar el bug de colisión AH con el
// dato exacto que devuelve la API (nombres/ids reales).
//
//   node --env-file=.env scripts/diagnose-odds-raw.js 1542333
//   node --env-file=.env scripts/diagnose-odds-raw.js 1542333 1xbet
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

// MISMO classifyAH/ahKey que lib/api-football.js (copiados para diagnóstico standalone).
const ahKey = v => {
  const raw = (v.value || '').toString().trim();
  const m = raw.match(/^(Home|Away)\s*([+-]?\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const side = m[1].toLowerCase();
  const num = m[2].replace('-', 'm').replace('+', 'p').replace('.', '_');
  return `${side}_${num.startsWith('m') || num.startsWith('p') ? num : 'p' + num}`;
};
const classifyAH = (betName) => {
  const n = (betName || '').toLowerCase();
  if (!n.includes('handicap')) return null;
  if (/(1st|first)\s*half|half\s*(1st|first)|\(1st half\)/.test(n)) return 'h1';
  if (/(2nd|second)\s*half|half\s*(2nd|second)|\(2nd half\)/.test(n)) return 'h2';
  if (n.includes('half')) return null;
  return 'full';
};

(async () => {
  if (!KEY) { console.error('Falta FOOTBALL_API_KEY en el entorno.'); process.exit(1); }
  if (!fixtureId) { console.error('Uso: node scripts/diagnose-odds-raw.js <fixtureId> [bookmaker]'); process.exit(1); }

  const res = await fetch(`https://${API_HOST}/odds?fixture=${fixtureId}`, { headers: { 'x-apisports-key': KEY } });
  const json = await res.json();
  const bookmakers = json?.response?.[0]?.bookmakers || [];
  console.log(`\nfixture ${fixtureId} · bookmakers en respuesta: ${bookmakers.length}`);
  if (json?.errors && Object.keys(json.errors).length) console.log('errors:', JSON.stringify(json.errors));

  for (const bk of bookmakers) {
    const allowedAs = isAllowed(bk.name);
    if (bkFilter && !normBk(bk.name).includes(normBk(bkFilter))) continue;
    if (!bkFilter && !allowedAs) continue;

    const ahBets = (bk.bets || []).filter(b => (b.name || '').toLowerCase().includes('handicap'));
    if (!ahBets.length) continue;
    console.log(`\n══ ${bk.name} (id=${bk.id}) ${allowedAs ? `[autorizada: ${allowedAs}]` : '[NO autorizada]'} ══`);
    const routed = { full: {}, h1: {}, h2: {} };
    for (const bet of ahBets) {
      const cls = classifyAH(bet.name);
      console.log(`  bet id=${bet.id} name="${bet.name}"  → classifyAH=${cls}`);
      for (const v of bet.values || []) {
        const k = ahKey(v);
        console.log(`      value="${v.value}" odd=${v.odd}  → key=${k ?? '(no parsea)'}`);
        if (cls && k) { const tgt = cls === 'full' ? routed.full : cls === 'h1' ? routed.h1 : routed.h2; const o = parseFloat(v.odd); if (isFinite(o) && o > 1 && (!tgt[k] || o > tgt[k])) tgt[k] = o; }
      }
    }
    console.log(`  → asianHandicap (full): ${JSON.stringify(routed.full)}`);
    console.log(`  → asianHandicap1H     : ${JSON.stringify(routed.h1)}`);
    console.log(`  → asianHandicap2H     : ${JSON.stringify(routed.h2)}`);
    console.log(`  VERIFICA: away_p3_5 full = ${routed.full.away_p3_5 ?? '(no existe)'}  ·  2H away_p3_5 = ${routed.h2.away_p3_5 ?? '(no existe)'}`);
  }
  console.log('\nSi algún bet de 2ª mitad tiene name SIN token de mitad (p.ej. "Asian Handicap" duplicado),');
  console.log('classifyAH lo marcará "full" y habrá que enrutar por bet.id. Eso se ve arriba en los nombres reales.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
