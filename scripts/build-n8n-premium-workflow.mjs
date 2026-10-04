#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

// Telegram conserva por URL el archivo que recibe. Este valor debe
// cambiar cada vez que se modifique el renderer o la geometría del mosaico para
// impedir que vuelva a entregar una imagen antigua desde su propia caché.
const BASEBALL_IMAGE_LAYOUT_VERSION = 'horizontal-grid-4k-document-20260811-1';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Uso: node scripts/build-n8n-premium-workflow.mjs <entrada.json> <salida.json>');
}

const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
const internalCredentialId = process.env.N8N_CF_INTERNAL_AUTH_CREDENTIAL_ID;
const internalCredentialName = process.env.N8N_CF_INTERNAL_AUTH_CREDENTIAL_NAME || 'CF Análisis Internal API';
if (!internalCredentialId) {
  throw new Error('Falta N8N_CF_INTERNAL_AUTH_CREDENTIAL_ID');
}
if (!workflow || workflow.id !== 'PicksPremiumDia1') {
  throw new Error('El archivo no corresponde al workflow PICKS PREMIUM DIARIO');
}

const schedule = workflow.nodes.find(node => node.name === 'Schedule Trigger');
const gateFootball = workflow.nodes.find(node => node.name === 'Gate Futbol');
const sendFootball = workflow.nodes.find(node => node.name === 'Enviar Futbol');
const registerFootball = workflow.nodes.find(node => node.name === 'Registrar Futbol');
let baseballSchedule = workflow.nodes.find(node => node.name === 'Schedule Baseball');
const gateBaseball = workflow.nodes.find(node => node.name === 'Gate Baseball');
let loopBaseball = workflow.nodes.find(node => node.name === 'Loop Baseball');
let imageBaseball = workflow.nodes.find(node => node.name === 'Imagen Baseball');
const sendBaseball = workflow.nodes.find(node => node.name === 'Enviar Baseball');
const registerBaseball = workflow.nodes.find(node => node.name === 'Registrar Baseball');
let verifyBaseball = workflow.nodes.find(node => node.name === 'Verificar Baseball');
const requiredNodes = [
  'Feed Futbol',
  'Gate Futbol',
  'Imagen Futbol',
  'Enviar Futbol',
  'Registrar Futbol',
  'Feed Baseball',
  'Gate Baseball',
  'Enviar Baseball',
  'Registrar Baseball',
];
const existingNodes = new Set(workflow.nodes.map(node => node.name));
if (!schedule || !gateBaseball || !sendFootball || !registerFootball || !sendBaseball || !registerBaseball
    || requiredNodes.some(name => !existingNodes.has(name))) {
  throw new Error('Faltan nodos esenciales en el workflow premium');
}

const baseballImageBaseUrl = 'https://cfanalisis.com/api/telegram-premium/baseball-image';

function secureInternalRequest(node, url) {
  if (!node) throw new Error(`Falta nodo HTTP interno para ${url}`);
  node.parameters = {
    ...(node.parameters || {}),
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    url,
  };
  node.credentials = {
    ...(node.credentials || {}),
    httpHeaderAuth: { id: internalCredentialId, name: internalCredentialName },
  };
}

function addNode(name, template) {
  let node = workflow.nodes.find(item => item.name === name);
  if (!node) {
    node = structuredClone(template);
    node.name = name;
    workflow.nodes.push(node);
  }
  return node;
}

secureInternalRequest(workflow.nodes.find(node => node.name === 'Feed Futbol'), 'https://cfanalisis.com/api/telegram-premium/futbol');
secureInternalRequest(workflow.nodes.find(node => node.name === 'Feed Baseball'), 'https://cfanalisis.com/api/telegram-premium/baseball');
secureInternalRequest(workflow.nodes.find(node => node.name === 'Imagen Futbol'), '={{ $json.imageUrl }}');
gateFootball.parameters.jsCode = `const payload = $input.first()?.json || {};
if (payload.ok !== true) return [];
const data = payload.data || {};
if (!Array.isArray(data.matches) || data.matches.length === 0) return [];
const state = $getWorkflowStaticData('global');
const sent = (state.futbolSent && state.futbolSent.date === data.fecha)
  ? (state.futbolSent.fixtures || [])
  : [];
return data.matches
  .filter(match => match.fixtureId != null && !sent.includes(match.fixtureId))
  .map(match => ({ json: {
    date: data.fecha,
    fixtureId: match.fixtureId,
    match: (match.homeTeam || '') + ' vs ' + (match.awayTeam || ''),
    publication: match,
    imageUrl: 'https://cfanalisis.com/api/telegram-premium/futbol-image'
      + '?date=' + encodeURIComponent(data.fecha)
      + '&fixture=' + encodeURIComponent(match.fixtureId),
  } }));`;

// Fútbol conserva su programación original a los :10. Béisbol usa un trigger
// independiente para salir exactamente a las 18:00 de España; así cambiar un
// deporte no desplaza ni vuelve a ejecutar el otro.
schedule.parameters.rule = {
  interval: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1].map(hour => ({
    field: 'days',
    daysInterval: 1,
    triggerAtHour: hour,
    triggerAtMinute: 10,
  })),
};
if (!baseballSchedule) {
  baseballSchedule = structuredClone(schedule);
  baseballSchedule.id = '5f1f5400-57e4-4fe0-87a5-6d26667f1800';
  baseballSchedule.name = 'Schedule Baseball';
  baseballSchedule.position = [-760, 220];
  workflow.nodes.push(baseballSchedule);
}
baseballSchedule.parameters.rule = {
  interval: [18, 19, 20, 21, 22, 23, 0, 1].map(hour => ({
    field: 'days',
    daysInterval: 1,
    triggerAtHour: hour,
    triggerAtMinute: 0,
  })),
};

workflow.connections['Schedule Trigger'] = {
  main: [[{ node: 'Feed Futbol', type: 'main', index: 0 }]],
};
workflow.connections['Schedule Baseball'] = {
  main: [[{ node: 'Feed Baseball', type: 'main', index: 0 }]],
};
// Cada partido produce exactamente un mosaico 16:9 con todas sus tarjetas. La
// deduplicación vuelve a ser por fixture: un error reintenta solo ese juego.
gateBaseball.parameters.jsCode = `const payload = $input.first()?.json || {};
if (payload.ok !== true) return [];
const data = payload.data || {};
if (!Array.isArray(data.matches) || data.matches.length === 0) return [];

const bogotaHour = Number(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Bogota', hour: 'numeric', hourCycle: 'h23',
}).format(new Date()));
if (bogotaHour < 11) return [];

const state = $getWorkflowStaticData('global');
state.baseballRun = {
  date: data.fecha,
  attempted: 0,
  sent: 0,
  errors: [],
};
const sentFixtures = (state.baseballSent && state.baseballSent.date === data.fecha)
  ? (state.baseballSent.fixtures || [])
  : [];
return data.matches
  .filter(match => match.fixtureId != null && !sentFixtures.includes(match.fixtureId))
  .map(match => ({
    json: {
      date: data.fecha,
      fixtureId: match.fixtureId,
      match: (match.homeTeam || '') + ' vs ' + (match.awayTeam || ''),
      publication: match,
      imageUrl: ${JSON.stringify(baseballImageBaseUrl)}
        + '?date=' + encodeURIComponent(data.fecha)
        + '&fixture=' + encodeURIComponent(match.fixtureId)
        + '&layout=' + encodeURIComponent(${JSON.stringify(BASEBALL_IMAGE_LAYOUT_VERSION)}),
    },
  }));`;

// Telegram es la autoridad de entrega: primero valida su respuesta, después
// persiste el snapshot exacto y solo entonces marca el fixture como enviado.
registerFootball.parameters.jsCode = `const items = $input.all();
const gates = $('Gate Futbol').all();
return items.map((item, index) => {
  const response = item.json || {};
  const gate = (gates[index] || {}).json || {};
  const messageId = response.result?.message_id;
  return { json: response.ok === true && messageId && gate.publication ? {
    sent: true,
    sport: 'football',
    date: gate.date,
    fixtureId: gate.fixtureId,
    telegramMessageId: Number(messageId),
    match: gate.publication,
  } : {
    sent: false,
    sport: 'football',
    date: gate.date,
    fixtureId: gate.fixtureId,
    error: response.description || 'Telegram no confirmó el envío de fútbol',
  } };
});`;

const persistFootball = addNode('Persistir Publicacion Futbol', {
  id: '9d39b755-9f0f-40ef-9d0c-4d9ea8ca1101',
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [700, -80], parameters: {},
});
persistFootball.parameters = {
  method: 'POST', sendBody: true, contentType: 'json', specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json) }}',
  options: { response: { response: { neverError: false, fullResponse: false, responseFormat: 'json' } }, timeout: 60000 },
};
secureInternalRequest(persistFootball, 'https://cfanalisis.com/api/cron/telegram-premium-publications');

const confirmFootball = addNode('Confirmar Publicacion Futbol', {
  id: 'b63d4a25-3bcd-4ac8-8c97-6f47b9ca1102',
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [920, -80], parameters: {},
});
confirmFootball.parameters.jsCode = `const state = $getWorkflowStaticData('global');
const responses = $input.all();
const registrations = $('Registrar Futbol').all();
for (let index = 0; index < responses.length; index++) {
  const response = responses[index].json || {};
  const registration = (registrations[index] || {}).json || {};
  if (response.ok === true && response.registered === true && registration.sent === true) {
    if (!state.futbolSent || state.futbolSent.date !== registration.date) {
      state.futbolSent = { date: registration.date, fixtures: [] };
    }
    if (!state.futbolSent.fixtures.includes(registration.fixtureId)) {
      state.futbolSent.fixtures.push(registration.fixtureId);
    }
    state.lastFutbolMessageId = registration.telegramMessageId;
    state.lastFutbolError = null;
  } else if (registration.sent !== true) {
    state.lastFutbolError = { at: new Date().toISOString(), fixtureId: registration.fixtureId || null, message: registration.error || 'Envío no confirmado' };
  } else {
    throw new Error('Telegram envió fútbol pero no se pudo persistir su snapshot Premium');
  }
}
return responses;`;

registerBaseball.parameters.jsCode = `const items = $input.all();
const gate = $('Loop Baseball').item.json || {};
return items.map(item => {
  const response = item.json || {};
  const document = response.result?.document;
  const validPng = document?.mime_type === 'image/png'
    && Number(document.file_size) >= 10000;
  const messageId = response.result?.message_id;
  return { json: response.ok === true && validPng && messageId && gate.publication ? {
    sent: true,
    sport: 'baseball',
    date: gate.date,
    fixtureId: gate.fixtureId,
    telegramMessageId: Number(messageId),
    match: gate.publication,
  } : {
    sent: false,
    sport: 'baseball',
    date: gate.date,
    fixtureId: gate.fixtureId,
    error: response.error?.message || response.description
      || (response.ok === true ? 'Telegram no devolvió un PNG válido' : 'Fallo de imagen o Telegram'),
  } };
});`;

const persistBaseball = addNode('Persistir Publicacion Baseball', {
  id: 'f204378d-af72-42b7-b3bb-f089a9ca1201',
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [700, 220], parameters: {},
});
persistBaseball.parameters = structuredClone(persistFootball.parameters);
secureInternalRequest(persistBaseball, 'https://cfanalisis.com/api/cron/telegram-premium-publications');

const confirmBaseball = addNode('Confirmar Publicacion Baseball', {
  id: '0ed19d74-c76e-4c9a-87ac-b755daca1202',
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [920, 220], parameters: {},
});
confirmBaseball.parameters.jsCode = `const state = $getWorkflowStaticData('global');
const response = $input.first()?.json || {};
const registration = $('Registrar Baseball').item.json || {};
const run = state.baseballRun || (state.baseballRun = { date: registration.date || null, attempted: 0, sent: 0, errors: [] });
run.attempted += 1;
if (response.ok === true && response.registered === true && registration.sent === true) {
  if (!state.baseballSent || state.baseballSent.date !== registration.date) {
    state.baseballSent = { date: registration.date, fixtures: [] };
  }
  if (!Array.isArray(state.baseballSent.fixtures)) state.baseballSent.fixtures = [];
  if (!state.baseballSent.fixtures.includes(registration.fixtureId)) state.baseballSent.fixtures.push(registration.fixtureId);
  state.lastBaseballMessageId = registration.telegramMessageId;
  run.sent += 1;
} else {
  const failure = { at: new Date().toISOString(), fixtureId: registration.fixtureId || null,
    message: registration.error || 'Telegram envió béisbol pero no se pudo persistir su snapshot Premium' };
  run.errors.push(failure);
  state.lastBaseballError = failure;
}
return $input.all();`;

if (!loopBaseball) {
  loopBaseball = {
    id: '6b4f2c11-0000-4c60-9a0d-bbbbbbbb000b',
    name: 'Loop Baseball',
    type: 'n8n-nodes-base.splitInBatches',
    typeVersion: 3,
    position: [-180, 220],
    parameters: {},
  };
  workflow.nodes.push(loopBaseball);
}
loopBaseball.parameters = { batchSize: 1, options: {} };

if (!verifyBaseball) {
  verifyBaseball = {
    id: '7c5f3d22-0000-4c60-9a0d-cccccccc000b',
    name: 'Verificar Baseball',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [800, 80],
    parameters: {},
  };
  workflow.nodes.push(verifyBaseball);
}
verifyBaseball.parameters = {
  mode: 'runOnceForAllItems',
  jsCode: `const state = $getWorkflowStaticData('global');
const run = state.baseballRun || { attempted: 0, sent: 0, errors: [] };
if (run.errors.length > 0) {
  const fixtures = run.errors.map(error => error.fixtureId).filter(Boolean).join(', ');
  throw new Error('Baseball Premium fallo en ' + run.errors.length + '/' + run.attempted
    + ' envios. Fixtures: ' + (fixtures || 'desconocidos'));
}
state.lastBaseballError = null;
return [{ json: { ok: true, attempted: run.attempted, sent: run.sent } }];`,
};
// sendPhoto recomprime la imagen. Para conservar el PNG 4K exacto, n8n lo
// descarga de uno en uno y lo sube como documento multipart sin compresión.
if (!imageBaseball) {
  imageBaseball = {
    id: '3f8e2a10-0000-4c60-9a0d-aaaaaaaa000b',
    name: 'Imagen Baseball',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    position: [0, 220],
    parameters: {},
  };
  workflow.nodes.push(imageBaseball);
}
imageBaseball.parameters = {
  url: '={{ $json.imageUrl }}',
  options: {
    timeout: 300000,
    response: {
      response: { neverError: false, fullResponse: false, responseFormat: 'file' },
    },
  },
};
secureInternalRequest(imageBaseball, '={{ $json.imageUrl }}');
imageBaseball.onError = 'continueRegularOutput';
sendBaseball.parameters = {
  resource: 'message',
  operation: 'sendDocument',
  chatId: sendBaseball.parameters?.chatId || sendFootball.parameters?.chatId,
  binaryData: true,
  binaryPropertyName: 'data',
  additionalFields: { fileName: 'cfanalisis-baseball.png' },
};
// Un timeout aislado no debe cancelar el lote completo: Registrar Baseball
// conserva los éxitos y deja exclusivamente ese fixture para el próximo pase.
sendBaseball.onError = 'continueRegularOutput';
workflow.connections['Gate Baseball'] = {
  main: [[{ node: 'Loop Baseball', type: 'main', index: 0 }]],
};
workflow.connections['Loop Baseball'] = {
  main: [
    [{ node: 'Verificar Baseball', type: 'main', index: 0 }],
    [{ node: 'Imagen Baseball', type: 'main', index: 0 }],
  ],
};
workflow.connections['Imagen Baseball'] = {
  main: [[{ node: 'Enviar Baseball', type: 'main', index: 0 }]],
};
workflow.connections['Registrar Futbol'] = {
  main: [[{ node: 'Persistir Publicacion Futbol', type: 'main', index: 0 }]],
};
workflow.connections['Persistir Publicacion Futbol'] = {
  main: [[{ node: 'Confirmar Publicacion Futbol', type: 'main', index: 0 }]],
};
workflow.connections['Registrar Baseball'] = {
  main: [[{ node: 'Persistir Publicacion Baseball', type: 'main', index: 0 }]],
};
workflow.connections['Persistir Publicacion Baseball'] = {
  main: [[{ node: 'Confirmar Publicacion Baseball', type: 'main', index: 0 }]],
};
workflow.connections['Confirmar Publicacion Baseball'] = {
  main: [[{ node: 'Loop Baseball', type: 'main', index: 0 }]],
};

// Los cierres viven en el mismo workflow y usan la misma credencial/canal que
// los Picks Premium. La API entrega únicamente snapshots previamente
// confirmados por Telegram; combinada_dia no participa en este flujo.
const resultSchedule = addNode('Revisar resultados Premium', {
  id: '60b580ea-b9a1-4ea9-b274-778c9aca1301',
  type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-760, 500], parameters: {},
});
resultSchedule.parameters.rule = { interval: [{ field: 'minutes', minutesInterval: 5 }] };

const resultFeed = addNode('Consultar resultados Premium', {
  id: '3cd94a15-cb8c-4ea1-bbf6-c50d3aca1302',
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [-520, 500], parameters: {},
});
resultFeed.parameters = {
  method: 'GET',
  options: { response: { response: { neverError: false, fullResponse: false, responseFormat: 'json' } }, timeout: 60000 },
};
secureInternalRequest(resultFeed, 'https://cfanalisis.com/api/cron/telegram-premium-results');

const resultGate = addNode('Preparar resultados Premium', {
  id: '252ae4a4-8b21-4fdc-abac-2040caca1303',
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [-280, 500], parameters: {},
});
resultGate.parameters.jsCode = `const payload = $input.first()?.json || {};
if (payload.ok !== true) throw new Error('CF Análisis no pudo consultar resultados Premium: ' + (payload.error || 'respuesta inválida'));
if (!payload.event) return [];
const event = payload.event;
if (!event.eventId || !event.claimToken || !event.message) throw new Error('Resultado Premium incompleto');
return [{ json: event }];`;

const resultTelegram = addNode('Enviar resultado Premium', {
  ...structuredClone(sendFootball),
  id: 'e110bb4d-29d7-44ab-b170-acde9aca1304',
  position: [-40, 500],
});
resultTelegram.parameters = {
  resource: 'message', operation: 'sendMessage', chatId: sendFootball.parameters.chatId,
  text: '={{ $json.message }}',
  additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
};

const resultAck = addNode('Confirmar resultado Premium', {
  id: '3c40fe4f-bb20-40c7-a888-c6c9baca1305',
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [200, 500], parameters: {},
});
resultAck.parameters = {
  method: 'POST', sendBody: true, contentType: 'json', specifyBody: 'keypair',
  bodyParameters: { parameters: [
    { name: 'eventId', value: "={{ $('Preparar resultados Premium').item.json.eventId }}" },
    { name: 'claimToken', value: "={{ $('Preparar resultados Premium').item.json.claimToken }}" },
  ] },
  options: { response: { response: { neverError: false, fullResponse: false, responseFormat: 'json' } }, timeout: 60000 },
};
secureInternalRequest(resultAck, 'https://cfanalisis.com/api/cron/telegram-premium-results');

workflow.connections['Revisar resultados Premium'] = {
  main: [[{ node: 'Consultar resultados Premium', type: 'main', index: 0 }]],
};
workflow.connections['Consultar resultados Premium'] = {
  main: [[{ node: 'Preparar resultados Premium', type: 'main', index: 0 }]],
};
workflow.connections['Preparar resultados Premium'] = {
  main: [[{ node: 'Enviar resultado Premium', type: 'main', index: 0 }]],
};
workflow.connections['Enviar resultado Premium'] = {
  main: [[{ node: 'Confirmar resultado Premium', type: 'main', index: 0 }]],
};

workflow.settings = {
  ...(workflow.settings || {}),
  timezone: 'Europe/Madrid',
};
workflow.active = true;
workflow.description = 'Publica picks Premium diarios por partido, registra el snapshot exacto solo tras confirmación de Telegram y envía sus resultados oficiales en el mismo canal. Fútbol conserva sus disparos a los :10; béisbol sale desde las 18:00 de España, procesa un juego por vez y envía PNG 4K sin compresión.';
workflow.pinData = {};

writeFileSync(outputPath, `${JSON.stringify([workflow], null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  id: workflow.id,
  timezone: workflow.settings.timezone,
  footballSchedule: schedule.parameters.rule.interval,
  baseballSchedule: baseballSchedule.parameters.rule.interval,
  baseballImageLayoutVersion: BASEBALL_IMAGE_LAYOUT_VERSION,
  outputPath,
}, null, 2));
