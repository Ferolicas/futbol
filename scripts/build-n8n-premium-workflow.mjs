#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

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
const sendBaseball = workflow.nodes.find(node => node.name === 'Enviar Baseball');
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
if (!schedule || !sendBaseball || requiredNodes.some(name => !existingNodes.has(name))) {
  throw new Error('Faltan nodos esenciales en el workflow premium');
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
};
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
workflow.description = 'Publica picks premium diarios por partido: fútbol conserva sus disparos a los :10 y béisbol sale desde las 18:00 de España a horas en punto, enviando las PNG por URL directa con deduplicación y reintentos hasta la 01:00.';
workflow.pinData = {};

writeFileSync(outputPath, `${JSON.stringify([workflow], null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  id: workflow.id,
  timezone: workflow.settings.timezone,
  footballSchedule: schedule.parameters.rule.interval,
  baseballSchedule: baseballSchedule.parameters.rule.interval,
  outputPath,
}, null, 2));
