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
