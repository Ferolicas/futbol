const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('el frontend diario lee el catálogo selectable y aplica el gate centralizado', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/page.js'), 'utf8');
  assert.match(source, /data\.combinada\.selectable \|\| data\.combinada\.selections/);
  assert.match(source, /isFootballFrontendDailyPickEligible\(sel\)/);
  assert.doesNotMatch(source, /const MIN_PROB = 90/);
});

test('web y apps comparten el mismo gate de Apuesta del Día', () => {
  const web = fs.readFileSync(path.join(__dirname, '../lib/recommendation-policy.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '../apps/cfanalisis-mobile/src/shared/recommendation-policy.js'), 'utf8');
  const functionBody = source => source.match(/export function isFootballFrontendDailyPickEligible\(selection\) \{[\s\S]*?\n\}/)?.[0];
  assert.equal(functionBody(mobile), functionBody(web));
  assert.doesNotMatch(functionBody(mobile), /validationStatus|expectedValue/);
});

test('la Apuesta del Día muestra cuotas individuales y no fabrica una cuota total', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/page.js'), 'utf8');
  assert.match(source, /cuotas individuales/);
  assert.doesNotMatch(source, /apuestaDelDia\.combinedOdd/);
  assert.doesNotMatch(source, /const combinedOdd\s*=\s*all\.reduce/);
});

test('el EV se muestra como metadato secundario y no desplaza probabilidad ni cuota', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/page.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../app/globals.css'), 'utf8');
  assert.match(source, /className="daily-pick-ev"/);
  assert.match(source, /className="mkt-ev"/);
  assert.match(styles, /\.daily-pick-card-metrics \.daily-pick-ev/);
  assert.match(styles, /\.mkt-ev/);
  assert.match(styles, /rgba\(203, 213, 225, \.55\)/);
});

test('una jornada pasada usa la Apuesta del día publicada y no la reconstruye con reglas nuevas', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/page.js'), 'utf8');
  assert.match(source, /historicalDailySelections/);
  assert.match(source, /if \(isViewingPast\)/);
  assert.match(source, /historicalSnapshot: true/);
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
  assert.match(source, /confidence < 90/);
  // La cuota solo filtra por debajo de 1.20: ya no existe techo.
  assert.match(source, /odd < 1\.2/);
  assert.doesNotMatch(source, /odd > 1\.6/);
  assert.match(source, /n8n-nodes-base\.executeWorkflowTrigger/);
  assert.match(source, /response\.result\?\.message_id/);
  assert.match(source, /appendAttribution: false/);
});

test('n8n publica una imagen por partido, sin combinada', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build-n8n-telegram-workflow.mjs'), 'utf8');
  assert.match(source, /Array\.isArray\(data\.matches\)/);
  assert.match(source, /options\.length < 1 \|\| options\.length > 3/);
  assert.match(source, /source\.slice\(0, 2\)\.map/);
  assert.match(source, /return matches\.map\(\(match, index\) => \{/);
  assert.match(source, /'match=' \+ encode\(JSON\.stringify\(displayMatch\)\)/);
  // Sin combinada no hay cuota total ni probabilidad conjunta.
  assert.doesNotMatch(source, /totalOdd/);
  assert.doesNotMatch(source, /totalProbability/);
  assert.doesNotMatch(source, /selections=/);
});

test('el bot diario publica resultados solo desde el snapshot confirmado por Telegram', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build-n8n-telegram-workflow.mjs'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../app/api/cron/telegram-results/route.js'), 'utf8');
  const hardening = fs.readFileSync(path.join(__dirname, '../scripts/vps/secure-n8n-internal-auth.cjs'), 'utf8');
  assert.match(source, /url: 'https:\/\/cfanalisis\.com\/api\/cron\/telegram-results'/);
  assert.match(source, /resultSchedule, resultFeed, resultGate, resultTelegram, resultAck/);
  assert.match(source, /'Revisar resultados':/);
  assert.match(route, /FROM prediction_runs/);
  assert.match(route, /prediction_settlements/);
  assert.match(route, /telegram_result_notifications/);
  assert.doesNotMatch(route, /settleMarketSelection/);
  assert.doesNotMatch(route, /telegram_premium|baseball/);
  assert.match(hardening, /'Persistir envio diario'/);
  assert.match(hardening, /appendAttribution: false/);
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
