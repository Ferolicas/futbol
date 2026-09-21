const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('WebMCP usa document.modelContext, herramienta de solo lectura y AbortSignal', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/dashboard/components/MatchAssistant.js'), 'utf8');
  assert.match(source, /document\.modelContext/);
  assert.match(source, /registerTool/);
  assert.match(source, /readOnlyHint:\s*true/);
  assert.match(source, /controller\.abort\(\)/);
  assert.doesNotMatch(source, /navigator\.modelContext/);
});
test('el asistente Groq solo expone herramientas de consulta existentes', () => {
  const route = fs.readFileSync(path.join(__dirname, '../app/api/assistant/chat/route.js'), 'utf8');
  const tools = fs.readFileSync(path.join(__dirname, '../lib/cf-assistant.js'), 'utf8');
  assert.match(route, /GROQ_API_KEY/);
  assert.match(route, /userHasActivePlan/);
  assert.match(tools, /search_existing_matches/);
  assert.match(tools, /get_existing_prediction/);
  assert.doesNotMatch(tools, /analyzeMatch|recordPredictionRun|saveSportPrediction|UPDATE\s+prediction_runs/i);
});

test('la verificación pública oculta el contenido técnico hasta el kickoff', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/api/verificar-pronostico/[id]/route.js'), 'utf8');
  assert.match(source, /contentRedacted = Date\.now\(\) < new Date\(row\.kickoff\)/);
  assert.match(source, /contentRedacted \? \{\} :/);
  assert.match(source, /verifyStoredPredictionProof/);
});
