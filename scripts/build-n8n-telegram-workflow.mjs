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
  'no match with three eligible options',
]);

if (payload.ok !== true) {
  if (expectedNoPick.has(payload.reason)) return [];
  throw new Error('CF Análisis no pudo preparar la apuesta: ' + (payload.reason || payload.error || 'respuesta inválida'));
}

const data = payload.data || {};
const source = Array.isArray(data.matches) ? data.matches : [];
const state = $getWorkflowStaticData('global');

if (state.lastTelegramDate === data.fecha) return [];

if (source.length < 1 || source.length > 3) {
  throw new Error('Cantidad de partidos fuera de regla');
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

// La cuota solo filtra por debajo de 1.20 y no tiene techo: lo que decide es
// probabilidad (>=85%) y fiabilidad (>=90%).
const matches = source.map(match => {
  const options = Array.isArray(match.options) ? match.options : [];
  if (options.length !== 3) {
    throw new Error('El backend devolvió un partido sin sus tres opciones');
  }
  return {
    homeTeam: match.homeTeam || '',
    awayTeam: match.awayTeam || '',
    homeLogo: match.homeLogo || '',
    awayLogo: match.awayLogo || '',
    league: match.league || '',
    time: formatTime(match.kickoff),
    options: options.map(option => {
      const rawProbability = Number(option.rawProbability ?? option.probability);
      const probability = Number(option.probability);
      const rawReliability = Number(option.confidence);
      const reliability = rawReliability >= 0 && rawReliability <= 1
        ? rawReliability * 100
        : rawReliability;
      const odd = Number(option.odd);
      if (!allowedMarket(option)
          || !Number.isFinite(rawProbability) || rawProbability < 85
          || !Number.isFinite(reliability) || reliability < 90
          || !Number.isFinite(odd) || odd < 1.2) {
        throw new Error('El backend devolvió un mercado fuera de las reglas de Telegram');
      }
      return {
        name: String(option.name || '')
          .replace(/\bOver\b/gi, 'Más de')
          .replace(/\bUnder\b/gi, 'Menos de'),
        probability: Math.min(95, probability),
        confidence: reliability,
        odd,
      };
    }),
  };
});

const [year, month, day] = String(data.fecha || '').split('-');
const displayDate = year && month && day ? day + '/' + month + '/' + year : '';
const encode = value => encodeURIComponent(String(value ?? ''));
const caption = '<a href="https://cfanalisis.com">Si quieres cuotas más altas y más análisis, entra a CF Análisis</a>';

// Un item por partido: el nodo de Telegram se ejecuta una vez por item, así que
// salen tres fotos distintas. El enlace va solo en la primera para no repetirlo.
return matches.map((match, index) => ({
  json: {
    imageUrl: 'https://cfanalisis.com/api/pick-image?' + [
      'fecha=' + encode(displayDate),
      'match=' + encode(JSON.stringify(match)),
      'ts=' + encode(data.fecha || ''),
    ].join('&'),
    caption: index === 0 ? caption : '',
    matches: matches.length,
    date: data.fecha,
  },
}));`;

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
const telegramResponse = $input.first()?.json || {};
const state = $getWorkflowStaticData('global');
state.lastTelegramDate = prepared.date;
state.lastTelegramMessageId = telegramResponse.message_id || telegramResponse.result?.message_id || null;
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
workflow.description = 'Publica cada día hasta 3 partidos en Telegram, una imagen por partido con sus 3 opciones (>=85% probabilidad, >=90% fiabilidad, cuota >=1.20), sin IA.';
workflow.pinData = {};

writeFileSync(outputPath, `${JSON.stringify([workflow], null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  id: workflow.id,
  nodes: workflow.nodes.map(node => node.name),
  connections: Object.keys(workflow.connections),
  outputPath,
}, null, 2));
