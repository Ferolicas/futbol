#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Uso: node scripts/build-n8n-telegram-workflow.mjs <entrada.json> <salida.json>');
}

const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
if (!workflow || workflow.id !== 'yrqca9FJFPClDu8H') {
  throw new Error('El archivo no corresponde al workflow COMBINADA DEL DIA');
}

const byName = new Map(workflow.nodes.map(node => [node.name, structuredClone(node)]));
const schedule = byName.get('Schedule Trigger');
const executeTrigger = byName.get('Execute Workflow Trigger') || {
  parameters: {},
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  typeVersion: 1,
  id: 'a5cbf768-ced6-4bdd-b935-66fa74089e5b',
  name: 'Execute Workflow Trigger',
};
const publish = byName.get('HTTP Request');
const code = byName.get('Code1');
const telegram = byName.get('Send a photo message');
const finalize = byName.get('Registrar envio') || byName.get('Code in JavaScript1');
if (!schedule || !publish || !code || !telegram || !finalize) {
  throw new Error('Faltan nodos esenciales en el workflow original');
}
if (!String(publish.parameters?.url || '').includes('/api/cron/publish-combinada')) {
  throw new Error('El nodo HTTP no apunta al publicador esperado');
}

schedule.position = [-720, 0];
executeTrigger.position = [-720, 180];
publish.position = [-480, 0];
code.position = [-220, 0];
telegram.position = [80, 0];
finalize.position = [340, 0];

// Reintenta durante la tarde si a las 13:00 todavía no hay suficientes
// análisis. El estado global impide publicar más de una vez por fecha.
schedule.parameters.rule = {
  interval: [13, 14, 15, 16, 17, 18].map(hour => ({
    field: 'days',
    daysInterval: 1,
    triggerAtHour: hour,
    triggerAtMinute: 0,
  })),
};

publish.parameters.options = {
  ...publish.parameters.options,
  response: {
    response: {
      neverError: false,
      fullResponse: false,
      responseFormat: 'json',
    },
  },
  timeout: 60000,
};

code.parameters.jsCode = String.raw`const payload = $input.first()?.json || {};

const expectedNoPick = new Set([
  'no analyzed fixtures',
  'no analyzed selections',
  'no allowed combination in target odds',
]);

if (payload.ok !== true) {
  if (expectedNoPick.has(payload.reason)) return [];
  throw new Error('CF Análisis no pudo preparar la apuesta: ' + (payload.reason || payload.error || 'respuesta inválida'));
}

const data = payload.data || {};
const source = Array.isArray(data.selections) ? data.selections : [];
const totalOdd = Number(data.combinedOdd);
const totalProbability = Number(data.combinedProbability);
const state = $getWorkflowStaticData('global');

if (state.lastTelegramDate === data.fecha) return [];

if (source.length < 1 || source.length > 3) {
  throw new Error('Cantidad de selecciones fuera de regla');
}
if (!Number.isFinite(totalOdd) || totalOdd < 1.5 || totalOdd > 2) {
  throw new Error('Cuota total fuera del rango 1.50–2.00');
}
if (!Number.isFinite(totalProbability) || totalProbability < 80) {
  throw new Error('Probabilidad conjunta inferior al 80%');
}

const normalize = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const allowedMarket = selection => {
  const text = normalize([selection.id, selection.category, selection.name].filter(Boolean).join(' '));
  if (/handicap|asian|winner|ganador|empate|draw|btts|ambos marcan|foul|falta|offside|fuera de juego/.test(text)) return false;
  return /(^|[^a-z])sot([^a-z]|$)|shotson|shots-on|tiros? a puerta|remates? a puerta|card|tarjet|corner|goal|gol/.test(text);
};

const formatTime = kickoff => {
  if (!kickoff) return '';
  const date = new Date(kickoff);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString('es-CO', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const selections = source.map(selection => {
  const rawProbability = Number(selection.rawProbability ?? selection.probability);
  const probability = Number(selection.probability);
  const rawReliability = Number(selection.confidence);
  const reliability = rawReliability >= 0 && rawReliability <= 1
    ? rawReliability * 100
    : rawReliability;
  const odd = Number(selection.odd);
  if (!allowedMarket(selection)
      || !Number.isFinite(rawProbability) || rawProbability < 80
      || !Number.isFinite(reliability) || reliability < 80
      || !Number.isFinite(odd) || odd < 1.2 || odd > 1.6) {
    throw new Error('El backend devolvió un mercado fuera de las reglas de Telegram');
  }
  return {
    homeTeam: selection.homeTeam || '',
    awayTeam: selection.awayTeam || '',
    homeLogo: selection.homeLogo || '',
    awayLogo: selection.awayLogo || '',
    league: selection.league || '',
    name: String(selection.name || '')
      .replace(/\bOver\b/gi, 'Más de')
      .replace(/\bUnder\b/gi, 'Menos de'),
    probability: Math.min(95, probability),
    odd,
    time: formatTime(selection.kickoff),
  };
});

const [year, month, day] = String(data.fecha || '').split('-');
const displayDate = year && month && day ? day + '/' + month + '/' + year : '';
const encode = value => encodeURIComponent(String(value ?? ''));
const imageUrl = 'https://cfanalisis.com/api/pick-image?' + [
  'odd=' + encode(totalOdd.toFixed(2)),
  'prob=' + encode(Number.isFinite(totalProbability) ? totalProbability.toFixed(1) : ''),
  'fecha=' + encode(displayDate),
  'selections=' + encode(JSON.stringify(selections)),
  'ts=' + encode(data.fecha || ''),
].join('&');

const caption = '<a href="https://cfanalisis.com">Si quieres cuotas más altas y más análisis, entra a CF Análisis</a>';
return [{ json: { imageUrl, caption, selections: selections.length, totalOdd, date: data.fecha } }];`;

telegram.parameters = {
  ...telegram.parameters,
  file: '={{ $json.imageUrl }}',
  operation: 'sendPhoto',
  binaryData: false,
  additionalFields: {
    ...(telegram.parameters?.additionalFields || {}),
    caption: '={{ $json.caption }}',
    parse_mode: 'HTML',
  },
};

finalize.name = 'Registrar envio';
finalize.parameters.jsCode = String.raw`const prepared = $('Code1').first().json;
const state = $getWorkflowStaticData('global');
state.lastTelegramDate = prepared.date;
state.lastTelegramMessageId = $input.first()?.json?.message_id || null;
return $input.all();`;

workflow.nodes = [schedule, executeTrigger, publish, code, telegram, finalize];
workflow.connections = {
  'Schedule Trigger': {
    main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]],
  },
  'Execute Workflow Trigger': {
    main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]],
  },
  'HTTP Request': {
    main: [[{ node: 'Code1', type: 'main', index: 0 }]],
  },
  Code1: {
    main: [[{ node: 'Send a photo message', type: 'main', index: 0 }]],
  },
  'Send a photo message': {
    main: [[{ node: 'Registrar envio', type: 'main', index: 0 }]],
  },
};
workflow.active = true;
workflow.description = 'Publica una apuesta diaria determinista de cuota 1.50–2.00 en Telegram, sin IA.';
workflow.pinData = {};

writeFileSync(outputPath, `${JSON.stringify([workflow], null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  id: workflow.id,
  nodes: workflow.nodes.map(node => node.name),
  connections: Object.keys(workflow.connections),
  outputPath,
}, null, 2));
