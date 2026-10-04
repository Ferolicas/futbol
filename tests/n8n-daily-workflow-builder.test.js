const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

function node(name, type, parameters = {}, extra = {}) {
  return { id: name, name, type, typeVersion: 2, parameters, position: [0, 0], ...extra };
}

test('el workflow diario guarda y liquida exactamente sus dos envíos de fútbol', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-daily-workflow-'));
  const input = join(dir, 'input.json');
  const output = join(dir, 'output.json');
  const nodes = [
    node('Schedule Trigger', 'n8n-nodes-base.scheduleTrigger', { rule: { interval: [] } }),
    node('Execute Workflow Trigger', 'n8n-nodes-base.executeWorkflowTrigger'),
    node('HTTP Request', 'n8n-nodes-base.httpRequest', {
      url: 'https://cfanalisis.com/api/cron/publish-combinada',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {},
    }, { credentials: { httpHeaderAuth: { id: 'internal-test', name: 'Internal' } } }),
    node('Code1', 'n8n-nodes-base.code', { jsCode: '' }),
    node('Send a photo message', 'n8n-nodes-base.telegram', {
      chatId: '-1003910091350', additionalFields: {},
    }, { credentials: { telegramApi: { id: 'daily-token', name: 'Diario' } } }),
    node('Registrar envio', 'n8n-nodes-base.code', { jsCode: '' }),
  ];
  writeFileSync(input, JSON.stringify([{
    id: 'yrqca9FJFPClDu8H', nodes, connections: {}, settings: {},
  }]));

  const result = spawnSync(process.execPath, ['scripts/build-n8n-telegram-workflow.mjs', input, output], {
    cwd: process.cwd(), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const workflow = JSON.parse(readFileSync(output, 'utf8'))[0];
  const names = new Set(workflow.nodes.map(item => item.name));
  for (const name of [
    'Persistir envio diario', 'Confirmar envio diario', 'Revisar resultados',
    'Consultar resultados', 'Preparar resultados', 'Enviar resultado', 'Confirmar resultado',
  ]) assert.ok(names.has(name), name);

  const photo = workflow.nodes.find(item => item.name === 'Send a photo message');
  const resultSend = workflow.nodes.find(item => item.name === 'Enviar resultado');
  const persist = workflow.nodes.find(item => item.name === 'Persistir envio diario');
  assert.equal(photo.parameters.additionalFields.appendAttribution, false);
  assert.equal(resultSend.parameters.additionalFields.appendAttribution, false);
  assert.equal(resultSend.parameters.chatId, '-1003910091350');
  assert.deepEqual(resultSend.credentials, photo.credentials);
  assert.match(persist.parameters.url, /telegram-daily-publications/);
  assert.equal(persist.credentials.httpHeaderAuth.id, 'internal-test');
  assert.match(workflow.nodes.find(item => item.name === 'Code1').parameters.jsCode, /publicationOptions/);
  assert.match(workflow.nodes.find(item => item.name === 'Code1').parameters.jsCode, /source\.slice\(0, 2\)/);
  assert.doesNotMatch(JSON.stringify(workflow), /Premium|premium|baseball/i);
  assert.equal(workflow.connections['Enviar resultado'].main[0][0].node, 'Confirmar resultado');
});
