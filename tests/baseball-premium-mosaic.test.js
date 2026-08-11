const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

let layout;
let image;

test.before(async () => {
  layout = await import('../lib/baseball-premium-mosaic-layout.js');
  image = await import('../lib/baseball-premium-mosaic-image.js');
});

const option = (name, index) => ({
  id: `${name}-${index}`,
  name: `${name} ${index}`,
  probability: 70 + (index % 20),
  confidence: 90 + (index % 8),
  odd: index % 3 ? null : 1.72,
});

function options(name, count) {
  return Array.from({ length: count }, (_, index) => option(name, index + 1));
}

function match() {
  return {
    fixtureId: 9001,
    homeTeam: 'New York Yankees',
    awayTeam: 'Boston Red Sox',
    league: 'MLB',
    kickoff: '2026-08-11T23:10:00Z',
    pitchers: {
      home: { name: 'Gerrit Cole', stats: { era: 3.1, whip: 1.05, k9: 9.8 } },
      away: { name: 'Garrett Crochet', stats: { era: 2.9, whip: 1.01, k9: 11.2 } },
    },
    groups: {
      carreras: options('Carreras', 24),
      hits: options('Hits', 12),
      bateadores: options('Bateador', 3),
      strikeouts: options('Strikeouts', 6),
    },
  };
}

const order = ['carreras', 'hits', 'bateadores', 'strikeouts'];
const labels = {
  carreras: 'CARRERAS',
  hits: 'HITS',
  bateadores: 'BATEADORES',
  strikeouts: 'STRIKEOUTS',
};

test('incluye todas las tarjetas del partido en una única imagen horizontal', () => {
  const pages = layout.buildBaseballMosaicPages(match(), order, labels);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].cards.length, 8);
  assert.ok(pages[0].cards.every((card) => card.options.length <= 6));
  assert.equal(
    pages[0].cards.reduce((total, card) => total + card.options.length, 0),
    45,
  );
  assert.equal(layout.baseballMosaicPageCount(match(), order, labels), 1);
  assert.deepEqual(layout.baseballMosaicGrid(pages[0].cards.length), { columns: 4, rows: 2 });
});

test('conserva orden, familia y numeración de las continuaciones', () => {
  const cards = layout.buildBaseballMosaicCards(match(), order, labels);
  assert.deepEqual(cards.slice(0, 4).map((card) => [card.family, card.part, card.parts]), [
    ['carreras', 1, 4],
    ['carreras', 2, 4],
    ['carreras', 3, 4],
    ['carreras', 4, 4],
  ]);
  assert.deepEqual(cards.map((card) => card.family), [
    'carreras', 'carreras', 'carreras', 'carreras', 'hits', 'hits', 'bateadores', 'strikeouts',
  ]);
});

test('renderiza la imagen única en 4K 3840x2160 exactos', async () => {
  const pages = layout.buildBaseballMosaicPages(match(), order, labels);
  const png = await image.renderBaseballPremiumMosaicPng({
    match: match(),
    date: '11/08/2026',
    page: pages[0],
  });
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 3840);
  assert.equal(metadata.height, 2160);
  assert.equal(metadata.format, 'png');
  assert.ok(png.length < 50 * 1024 * 1024, 'el PNG debe caber en el límite de documento de Telegram');
});
