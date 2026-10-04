const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

function node(name, parameters = {}) {
  return { id: name, name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters, position: [0, 0] };
}

test('el builder procesa cada imagen de baseball en un loop real y hace visible el fallo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-premium-workflow-'));
  const input = join(dir, 'input.json');
  const output = join(dir, 'output.json');
  const nodes = [
    node('Schedule Trigger', { rule: { interval: [] } }),
    node('Feed Futbol'), node('Gate Futbol'), node('Imagen Futbol'),
    node('Enviar Futbol'), node('Registrar Futbol'), node('Feed Baseball'),
    node('Gate Baseball', {
      jsCode: "const url = 'https://cfanalisis.com/api/telegram-premium/baseball-image';",
    }),
    node('Enviar Baseball', { url: 'https://api.telegram.org/bottest/sendPhoto' }),
    node('Registrar Baseball'),
  ];
  writeFileSync(input, JSON.stringify([{ id: 'PicksPremiumDia1', nodes, connections: {}, settings: {} }]));

  const result = spawnSync(process.execPath, ['scripts/build-n8n-premium-workflow.mjs', input, output], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, N8N_CF_INTERNAL_AUTH_CREDENTIAL_ID: 'credential-test' },
  });
  assert.equal(result.status, 0, result.stderr);

  const workflow = JSON.parse(readFileSync(output, 'utf8'))[0];
  const loop = workflow.nodes.find((item) => item.name === 'Loop Baseball');
  const verify = workflow.nodes.find((item) => item.name === 'Verificar Baseball');
  const image = workflow.nodes.find((item) => item.name === 'Imagen Baseball');
  const persistFootball = workflow.nodes.find((item) => item.name === 'Persistir Publicacion Futbol');
  const persistBaseball = workflow.nodes.find((item) => item.name === 'Persistir Publicacion Baseball');
  const resultSchedule = workflow.nodes.find((item) => item.name === 'Revisar resultados Premium');
  const resultSend = workflow.nodes.find((item) => item.name === 'Enviar resultado Premium');

  assert.equal(loop.type, 'n8n-nodes-base.splitInBatches');
  assert.equal(loop.typeVersion, 3);
  assert.equal(loop.parameters.batchSize, 1);
  assert.match(verify.parameters.jsCode, /throw new Error/);
  assert.equal(image.parameters.options.batching, undefined);
  assert.equal(image.parameters.authentication, 'genericCredentialType');
  assert.equal(image.credentials.httpHeaderAuth.id, 'credential-test');
  assert.doesNotMatch(JSON.stringify(workflow), /[?&]secret=/);
  assert.equal(persistFootball.credentials.httpHeaderAuth.id, 'credential-test');
  assert.equal(persistBaseball.credentials.httpHeaderAuth.id, 'credential-test');
  assert.match(persistFootball.parameters.url, /telegram-premium-publications/);
  assert.match(resultSchedule.parameters.rule.interval[0].minutesInterval.toString(), /5/);
  assert.equal(resultSend.parameters.operation, 'sendMessage');
  assert.match(JSON.stringify(workflow), /telegram-premium-results/);
  assert.match(workflow.nodes.find((item) => item.name === 'Gate Futbol').parameters.jsCode, /publication: match/);
  assert.match(workflow.nodes.find((item) => item.name === 'Gate Baseball').parameters.jsCode, /publication: match/);
  assert.equal(workflow.connections['Gate Baseball'].main[0][0].node, 'Loop Baseball');
  assert.equal(workflow.connections['Loop Baseball'].main[0][0].node, 'Verificar Baseball');
  assert.equal(workflow.connections['Loop Baseball'].main[1][0].node, 'Imagen Baseball');
  assert.equal(workflow.connections['Registrar Baseball'].main[0][0].node, 'Persistir Publicacion Baseball');
  assert.equal(workflow.connections['Confirmar Publicacion Baseball'].main[0][0].node, 'Loop Baseball');
});
