const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('el frontend diario lee el catálogo selectable para poder incluir 75–79%', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/page.js'), 'utf8');
  assert.match(source, /data\.combinada\.selectable \|\| data\.combinada\.selections/);
  assert.match(source, /isFootballFrontendDailyPickEligible\(sel\)/);
  assert.doesNotMatch(source, /const MIN_PROB = 90/);
});

test('el publicador recupera fiabilidad durable antes de aplicar las reglas Telegram', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/api/cron/publish-combinada/route.js'), 'utf8');
  assert.match(source, /combinada\.selectable \|\| combinada\.selections/);
  assert.match(source, /raw\?\.scored\?\.\[sel\.id\]/);
  assert.match(source, /reliabilityPercent\(sel\.confidence/);
});

test('n8n conserva la defensa de probabilidad, fiabilidad y cuotas de Telegram', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build-n8n-telegram-workflow.mjs'), 'utf8');
  assert.match(source, /totalProbability < 80/);
  assert.match(source, /rawProbability < 80/);
  assert.match(source, /reliability < 80/);
  assert.match(source, /odd < 1\.2 \|\| odd > 1\.6/);
  assert.match(source, /n8n-nodes-base\.executeWorkflowTrigger/);
  assert.match(source, /telegramResponse\.result\?\.message_id/);
});
