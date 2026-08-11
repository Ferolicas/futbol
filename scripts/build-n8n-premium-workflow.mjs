#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

// Telegram conserva por URL el archivo que recibe en sendPhoto. Este valor debe
// cambiar cada vez que se modifique el renderer o la geometría del mosaico para
// impedir que vuelva a entregar una imagen antigua desde su propia caché.
const BASEBALL_IMAGE_LAYOUT_VERSION = 'horizontal-grid-2560-20260811-1';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Uso: node scripts/build-n8n-premium-workflow.mjs <entrada.json> <salida.json>');
}

const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
if (!workflow || workflow.id !== 'PicksPremiumDia1') {
  throw new Error('El archivo no corresponde al workflow PICKS PREMIUM DIARIO');
}

const schedule = workflow.nodes.find(node => node.name === 'Schedule Trigger');
let baseballSchedule = workflow.nodes.find(node => node.name === 'Schedule Baseball');
const gateBaseball = workflow.nodes.find(node => node.name === 'Gate Baseball');
const sendBaseball = workflow.nodes.find(node => node.name === 'Enviar Baseball');
const registerBaseball = workflow.nodes.find(node => node.name === 'Registrar Baseball');
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
if (!schedule || !gateBaseball || !sendBaseball || !registerBaseball
    || requiredNodes.some(name => !existingNodes.has(name))) {
  throw new Error('Faltan nodos esenciales en el workflow premium');
}

const currentGateCode = String(gateBaseball.parameters?.jsCode || '');
const baseballImageBaseUrl = currentGateCode.match(/['"](https:\/\/cfanalisis\.com\/api\/telegram-premium\/baseball-image\?secret=[^'"]+)['"]/)?.[1];
if (!baseballImageBaseUrl) {
  throw new Error('No se pudo conservar la URL autenticada de imágenes de béisbol');
}

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
      imageUrl: ${JSON.stringify(baseballImageBaseUrl)}
        + '&date=' + encodeURIComponent(data.fecha)
        + '&fixture=' + encodeURIComponent(match.fixtureId)
        + '&layout=' + encodeURIComponent(${JSON.stringify(BASEBALL_IMAGE_LAYOUT_VERSION)}),
    },
  }));`;

registerBaseball.parameters.jsCode = `const state = $getWorkflowStaticData('global');
const items = $input.all();
const gateItems = $('Gate Baseball').all();
for (let i = 0; i < items.length; i++) {
  const response = items[i].json || {};
  const gate = (gateItems[i] || {}).json || {};
  if (response.ok === true && gate.fixtureId != null) {
    if (!state.baseballSent || state.baseballSent.date !== gate.date) {
      state.baseballSent = { date: gate.date, fixtures: [] };
    }
    if (!Array.isArray(state.baseballSent.fixtures)) state.baseballSent.fixtures = [];
    if (!state.baseballSent.fixtures.includes(gate.fixtureId)) {
      state.baseballSent.fixtures.push(gate.fixtureId);
    }
    state.lastBaseballMessageId = (response.result && response.result.message_id)
      || state.lastBaseballMessageId || null;
    state.lastBaseballError = null;
  } else if (response.ok !== true) {
    state.lastBaseballError = {
      at: new Date().toISOString(),
      fixtureId: gate.fixtureId || null,
      response,
    };
  }
}
return items;`;
// Telegram acepta una URL HTTPS en `photo`. Evitamos descargar decenas de PNG
// altos dentro de n8n: el binario podía agotarse y llegar como archivo de 0 B.
// Telegram descarga la imagen directamente y n8n solo transporta la URL.
sendBaseball.parameters = {
  ...sendBaseball.parameters,
  sendBody: true,
  contentType: 'multipart-form-data',
  bodyParameters: {
    parameters: [
      { name: 'chat_id', value: '-1003870511303' },
      { name: 'photo', value: '={{ $json.imageUrl }}' },
    ],
  },
  options: {
    ...(sendBaseball.parameters.options || {}),
    // Telegram descarga y procesa el PNG remoto antes de responder. Un mosaico
    // grande puede tardar más de un minuto en frío, especialmente si incluye
    // muchas fotos de jugadores.
    timeout: 180000,
  },
};
// Un timeout aislado no debe cancelar el lote completo: Registrar Baseball
// conserva los éxitos y deja exclusivamente ese fixture para el próximo pase.
sendBaseball.onError = 'continueRegularOutput';
workflow.nodes = workflow.nodes.filter(node => node.name !== 'Imagen Baseball');
workflow.connections['Gate Baseball'] = {
  main: [[{ node: 'Enviar Baseball', type: 'main', index: 0 }]],
};
delete workflow.connections['Imagen Baseball'];

workflow.settings = {
  ...(workflow.settings || {}),
  timezone: 'Europe/Madrid',
};
workflow.active = true;
workflow.description = 'Publica picks premium diarios por partido: fútbol conserva sus disparos a los :10 y béisbol sale desde las 18:00 de España a horas en punto, enviando un mosaico PNG 16:9 por juego mediante URL directa, con deduplicación por fixture, tolerancia a fallos por partido y reintentos hasta la 01:00.';
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
