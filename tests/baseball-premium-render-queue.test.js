const test = require('node:test');
const assert = require('node:assert/strict');

test('serializa los renders 4K aunque lleguen al mismo tiempo', async () => {
  const { runBaseballPremiumRenderExclusive } = await import('../lib/baseball-premium-render-queue.js');
  let active = 0;
  let maxActive = 0;
  const completed = [];

  const tasks = [1, 2, 3, 4].map((id) => runBaseballPremiumRenderExclusive(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(id);
    active -= 1;
    return id;
  }));

  assert.deepEqual(await Promise.all(tasks), [1, 2, 3, 4]);
  assert.equal(maxActive, 1);
  assert.deepEqual(completed, [1, 2, 3, 4]);
});

test('continua la cola cuando un render falla', async () => {
  const { runBaseballPremiumRenderExclusive } = await import('../lib/baseball-premium-render-queue.js');
  const failed = runBaseballPremiumRenderExclusive(async () => {
    throw new Error('render fallido');
  });
  const recovered = runBaseballPremiumRenderExclusive(async () => 'ok');

  await assert.rejects(failed, /render fallido/);
  assert.equal(await recovered, 'ok');
});

test('el render aislado devuelve PNG 4K desde un proceso efimero', async () => {
  const sharp = require('sharp');
  const layout = await import('../lib/baseball-premium-mosaic-layout.js');
  const { renderBaseballPremiumMosaicPngIsolated } = await import('../lib/baseball-premium-render-queue.js');
  const match = {
    fixtureId: 77,
    homeTeam: 'Local',
    awayTeam: 'Visitante',
    league: 'MLB',
    pitchers: {},
    groups: {
      carreras: [{ name: 'Más de 7.5 carreras', probability: 73, confidence: 91, odd: 1.8 }],
    },
  };
  const page = layout.buildBaseballMosaicPages(
    match,
    ['carreras'],
    { carreras: 'CARRERAS' },
  )[0];
  const png = await renderBaseballPremiumMosaicPngIsolated({ match, date: '12/08/2026', page });
  const metadata = await sharp(png).metadata();

  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 3840);
  assert.equal(metadata.height, 2160);
});

test('resuelve los assets desde un cwd standalone anidado', async () => {
  const path = require('node:path');
  const {
    resolveBaseballPremiumProjectRoot,
  } = await import('../lib/baseball-premium-render-queue.js');
  const expected = path.resolve(__dirname, '..');
  const standalone = path.join(expected, '.next', 'standalone', '.next', 'server');
  assert.equal(resolveBaseballPremiumProjectRoot([standalone]), expected);
});
