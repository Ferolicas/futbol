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

test('la Apuesta del Día muestra cuotas individuales y no fabrica una cuota total', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/page.js'), 'utf8');
  assert.match(source, /cuotas individuales/);
  assert.doesNotMatch(source, /apuestaDelDia\.combinedOdd/);
  assert.doesNotMatch(source, /const combinedOdd\s*=\s*all\.reduce/);
});

test('el publicador recupera fiabilidad durable antes de aplicar las reglas Telegram', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/api/cron/publish-combinada/route.js'), 'utf8');
  assert.match(source, /combinada\.selectable \|\| combinada\.selections/);
  assert.match(source, /raw\?\.scored\?\.\[sel\.id\]/);
  assert.match(source, /reliabilityPercent\(sel\.confidence/);
});

test('n8n conserva la defensa de probabilidad, fiabilidad y cuota de Telegram', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build-n8n-telegram-workflow.mjs'), 'utf8');
  assert.match(source, /rawProbability < 85/);
  assert.match(source, /reliability < 90/);
  // La cuota solo filtra por debajo de 1.20: ya no existe techo.
  assert.match(source, /odd < 1\.2/);
  assert.doesNotMatch(source, /odd > 1\.6/);
  assert.match(source, /n8n-nodes-base\.executeWorkflowTrigger/);
  assert.match(source, /telegramResponse\.result\?\.message_id/);
});

test('n8n publica una imagen por partido, sin combinada', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build-n8n-telegram-workflow.mjs'), 'utf8');
  assert.match(source, /Array\.isArray\(data\.matches\)/);
  assert.match(source, /options\.length < 1 \|\| options\.length > 3/);
  assert.match(source, /source\.slice\(0, 2\)\.map/);
  assert.match(source, /return matches\.map\(\(match, index\) => \(\{/);
  assert.match(source, /'match=' \+ encode\(JSON\.stringify\(match\)\)/);
  // Sin combinada no hay cuota total ni probabilidad conjunta.
  assert.doesNotMatch(source, /totalOdd/);
  assert.doesNotMatch(source, /totalProbability/);
  assert.doesNotMatch(source, /selections=/);
});

test('el informe personal queda programado a las 08:00 de Madrid', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build-n8n-personal-market-report-workflow.mjs'), 'utf8');
  assert.match(source, /triggerAtHour: 8, triggerAtMinute: 0/);
  assert.match(source, /timezone: 'Europe\/Madrid'/);
  assert.match(source, /informes\?deporte=futbol&date=/);
  assert.match(source, /informes\?deporte=baseball&date=/);
  assert.match(source, /\$execution\.mode === 'trigger'/);
  assert.doesNotMatch(source, /sendDocument/);
  assert.doesNotMatch(source, /Informe diario 08:30/);
});
