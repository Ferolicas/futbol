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
const dailyTelegramCredentialId = process.env.N8N_TELEGRAM_DAILY_CREDENTIAL_ID;
const dailyTelegramCredentialName = process.env.N8N_TELEGRAM_DAILY_CREDENTIAL_NAME
  || 'Telegram CF Análisis Diario';
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
const finalize = byName.get('Preparar registro envio')
  || byName.get('Registrar envio')
  || byName.get('Code in JavaScript1');
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

const persistPublication = byName.get('Persistir envio diario') || {
  ...structuredClone(publish),
  id: 'f5d93241-853c-4c93-b28d-91caebc5af06',
  name: 'Persistir envio diario',
};
const confirmPublication = byName.get('Confirmar envio diario') || {
  ...structuredClone(code),
  id: 'a6e04352-964d-4da4-a39e-a2dbfcd6b017',
  name: 'Confirmar envio diario',
};
persistPublication.position = [590, 0];
confirmPublication.position = [840, 0];

const resultSchedule = byName.get('Revisar resultados') || {
  ...structuredClone(schedule),
  id: 'a0848d9c-30e7-45f8-9d0a-90e458edab01',
  name: 'Revisar resultados',
};
const resultFeed = byName.get('Consultar resultados') || {
  ...structuredClone(publish),
  id: 'b1959e0d-41f8-46a9-ae1b-a1f569febc02',
  name: 'Consultar resultados',
};
const resultGate = byName.get('Preparar resultados') || {
  ...structuredClone(code),
  id: 'c2a60f1e-5209-47ba-bf2c-b2067a0fcd03',
  name: 'Preparar resultados',
};
const resultTelegram = byName.get('Enviar resultado') || {
  ...structuredClone(telegram),
  id: 'd3b7102f-631a-48cb-803d-c3178b10de04',
  name: 'Enviar resultado',
};
const resultAck = byName.get('Confirmar resultado') || {
  ...structuredClone(publish),
  id: 'e4c82130-742b-49dc-914e-d4289c21ef05',
  name: 'Confirmar resultado',
};

resultSchedule.position = [-720, 360];
resultFeed.position = [-480, 360];
resultGate.position = [-220, 360];
resultTelegram.position = [80, 360];
resultAck.position = [340, 360];

// El cierre se consulta cada cinco minutos. El backend reserva como máximo un
// partido por pasada y conserva una cola durable, de modo que dos ejecuciones
// simultáneas no publican el mismo resultado.
resultSchedule.parameters.rule = {
  interval: [{ field: 'minutes', minutesInterval: 5 }],
};
resultFeed.parameters = {
  ...resultFeed.parameters,
  method: 'GET',
  url: 'https://cfanalisis.com/api/cron/telegram-results',
  options: {
    ...(resultFeed.parameters?.options || {}),
    response: {
      response: { neverError: false, fullResponse: false, responseFormat: 'json' },
    },
    timeout: 60000,
  },
};
resultGate.parameters = {
  jsCode: String.raw`const payload = $input.first()?.json || {};
if (payload.ok !== true) {
  throw new Error('CF Análisis no pudo consultar resultados: ' + (payload.error || 'respuesta inválida'));
}
if (!payload.event) return [];
const event = payload.event;
if (!event.eventId || !event.claimToken || !event.message) {
  throw new Error('El backend devolvió un resultado incompleto');
}
return [{ json: event }];`,
};
resultTelegram.parameters = {
  resource: 'message',
  operation: 'sendMessage',
  chatId: telegram.parameters.chatId,
  text: '={{ $json.message }}',
  additionalFields: {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    appendAttribution: false,
  },
};
resultAck.parameters = {
  ...resultAck.parameters,
  method: 'POST',
  url: 'https://cfanalisis.com/api/cron/telegram-results',
  sendBody: true,
  contentType: 'json',
  specifyBody: 'keypair',
  bodyParameters: {
    parameters: [
      { name: 'eventId', value: "={{ $('Preparar resultados').item.json.eventId }}" },
      { name: 'claimToken', value: "={{ $('Preparar resultados').item.json.claimToken }}" },
    ],
  },
  options: {
    ...(resultAck.parameters?.options || {}),
    response: {
      response: { neverError: false, fullResponse: false, responseFormat: 'json' },
    },
    timeout: 60000,
  },
};

// Todas las llamadas internas usan la misma credencial ya configurada en el
// publicador. El token de Telegram solo se usa en los dos nodos de envío.
for (const internalNode of [persistPublication, resultFeed, resultAck]) {
  internalNode.parameters.authentication = publish.parameters.authentication;
  internalNode.parameters.genericAuthType = publish.parameters.genericAuthType;
  internalNode.credentials = structuredClone(publish.credentials || {});
}

// Reintenta durante la tarde si a las 13:00 todavía no hay opciones válidas.
// El estado global impide publicar más de una vez por fecha.
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
  'no eligible matches',
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

if (source.length < 1) {
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
// Defensa final: aunque un backend antiguo devolviera más partidos, n8n jamás
// genera más de dos items para Telegram. El backend ya entrega el orden por
// probabilidad media y, a igualdad, fiabilidad media.
const matches = source.slice(0, 2).map(match => {
  const options = Array.isArray(match.options) ? match.options : [];
  if (options.length < 1 || options.length > 3) {
    throw new Error('El backend devolvió un partido fuera del rango de una a tres opciones');
  }
  const publicationOptions = options.map(option => {
    const rawProbability = Number(option.rawProbability ?? option.probability);
    const probability = Number(option.probability);
    const rawReliability = Number(option.confidence);
    const confidence = rawReliability >= 0 && rawReliability <= 1
      ? rawReliability * 100
      : rawReliability;
    const odd = Number(option.odd);
    if (!option.id || !allowedMarket(option)
        || !Number.isFinite(rawProbability) || rawProbability < 85
        || !Number.isFinite(confidence) || confidence < 90
        || !Number.isFinite(odd) || odd < 1.2) {
      throw new Error('El backend devolvió un mercado fuera de las reglas de Telegram');
    }
    return {
      id: String(option.id),
      name: String(option.name || '')
        .replace(/\bOver\b/gi, 'Más de')
        .replace(/\bUnder\b/gi, 'Menos de'),
      probability: Math.min(95, probability),
      rawProbability,
      confidence,
      odd,
      category: option.category ?? null,
      family: option.family ?? null,
      scope: option.scope ?? null,
      line: (option.line ?? option._line) == null ? null : Number(option.line ?? option._line),
      side: option.side ?? option._side ?? null,
      playerId: option.playerId ?? null,
      playerName: option.playerName ?? null,
    };
  });
  return {
    homeTeam: match.homeTeam || '',
    awayTeam: match.awayTeam || '',
    homeLogo: match.homeLogo || '',
    awayLogo: match.awayLogo || '',
    league: match.league || '',
    time: formatTime(match.kickoff),
    options: publicationOptions.map(({ name, probability, confidence, odd }) => ({
      name, probability, confidence, odd,
    })),
    publication: {
      fixtureId: match.fixtureId,
      homeId: match.homeId ?? null,
      awayId: match.awayId ?? null,
      homeTeam: match.homeTeam || '',
      awayTeam: match.awayTeam || '',
      league: match.league || '',
      kickoff: match.kickoff,
      options: publicationOptions,
    },
  };
});

const [year, month, day] = String(data.fecha || '').split('-');
const displayDate = year && month && day ? day + '/' + month + '/' + year : '';
const encode = value => encodeURIComponent(String(value ?? ''));
const caption = '<a href="https://cfanalisis.com">Si quieres cuotas más altas y más análisis, entra a CF Análisis</a>';

// Un item por partido: el nodo de Telegram se ejecuta una vez por item, así que
// sale una foto distinta por partido. El enlace va solo en la primera para no
// repetirlo.
return matches.map((match, index) => {
  const { publication, ...displayMatch } = match;
  return { json: {
    imageUrl: 'https://cfanalisis.com/api/pick-image?' + [
      'fecha=' + encode(displayDate),
      'match=' + encode(JSON.stringify(displayMatch)),
      'ts=' + encode(data.fecha || ''),
    ].join('&'),
    caption: index === 0 ? caption : '',
    matches: matches.length,
    date: data.fecha,
    fixtureId: publication.fixtureId,
    publication,
  },
  };
});`;

telegram.parameters = {
  ...telegram.parameters,
  file: '={{ $json.imageUrl }}',
  operation: 'sendPhoto',
  binaryData: false,
  additionalFields: {
    ...(telegram.parameters?.additionalFields || {}),
    caption: '={{ $json.caption }}',
    parse_mode: 'HTML',
    // n8n añade por defecto "realizado por n8n" cuando esta opción falta.
    appendAttribution: false,
  },
};
if (dailyTelegramCredentialId) {
  telegram.credentials = {
    telegramApi: { id: dailyTelegramCredentialId, name: dailyTelegramCredentialName },
  };
}
resultTelegram.credentials = structuredClone(telegram.credentials);

finalize.name = 'Preparar registro envio';
finalize.parameters.jsCode = String.raw`const sent = $input.all();
const prepared = $('Code1').all();
return sent.map((item, index) => {
  const response = item.json || {};
  const source = (prepared[index] || {}).json || {};
  const messageId = response.message_id || response.result?.message_id;
  if (!messageId || !source.publication || source.fixtureId == null) {
    throw new Error('Telegram no confirmó completamente el envío diario');
  }
  return { json: {
    sent: true,
    date: source.date,
    fixtureId: source.fixtureId,
    telegramMessageId: Number(messageId),
    match: source.publication,
  } };
});`;

persistPublication.parameters = {
  ...persistPublication.parameters,
  method: 'POST',
  url: 'https://cfanalisis.com/api/cron/telegram-daily-publications',
  sendBody: true,
  contentType: 'json',
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json) }}',
  options: {
    ...(persistPublication.parameters?.options || {}),
    response: {
      response: { neverError: false, fullResponse: false, responseFormat: 'json' },
    },
    timeout: 60000,
  },
};

confirmPublication.parameters.jsCode = String.raw`const responses = $input.all();
const registrations = $('Preparar registro envio').all();
const state = $getWorkflowStaticData('global');
for (let index = 0; index < responses.length; index++) {
  const response = responses[index].json || {};
  if (response.ok !== true || response.registered !== true) {
    throw new Error('Telegram envió la opción diaria, pero no se pudo guardar su contenido exacto');
  }
}
for (const item of registrations) {
  const registration = item.json || {};
  state.lastTelegramDate = registration.date;
  state.lastTelegramMessageId = registration.telegramMessageId;
}
return responses;`;

workflow.nodes = [
  schedule, executeTrigger, publish, code, telegram, finalize,
  persistPublication, confirmPublication,
  resultSchedule, resultFeed, resultGate, resultTelegram, resultAck,
];
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
    main: [[{ node: 'Preparar registro envio', type: 'main', index: 0 }]],
  },
  'Preparar registro envio': {
    main: [[{ node: 'Persistir envio diario', type: 'main', index: 0 }]],
  },
  'Persistir envio diario': {
    main: [[{ node: 'Confirmar envio diario', type: 'main', index: 0 }]],
  },
  'Revisar resultados': {
    main: [[{ node: 'Consultar resultados', type: 'main', index: 0 }]],
  },
  'Consultar resultados': {
    main: [[{ node: 'Preparar resultados', type: 'main', index: 0 }]],
  },
  'Preparar resultados': {
    main: [[{ node: 'Enviar resultado', type: 'main', index: 0 }]],
  },
  'Enviar resultado': {
    main: [[{ node: 'Confirmar resultado', type: 'main', index: 0 }]],
  },
};
workflow.settings = {
  ...(workflow.settings || {}),
  timezone: 'Europe/Madrid',
};
workflow.active = true;
workflow.description = 'Publica cada día como máximo 2 partidos de fútbol, guarda únicamente el contenido exacto confirmado por Telegram y envía después el resultado de esas mismas opciones en el mismo canal. Cada imagen lleva de 1 a 3 opciones (>=85% probabilidad, >=90% fiabilidad, cuota >=1.20).';
workflow.pinData = {};

writeFileSync(outputPath, `${JSON.stringify([workflow], null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  id: workflow.id,
  nodes: workflow.nodes.map(node => node.name),
  connections: Object.keys(workflow.connections),
  outputPath,
}, null, 2));
