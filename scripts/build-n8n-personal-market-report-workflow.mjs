#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

const [inputPath, outputPath, chatId] = process.argv.slice(2);
if (!inputPath || !outputPath || !/^\d{6,20}$/.test(String(chatId || ''))) {
  throw new Error('Uso: node scripts/build-n8n-personal-market-report-workflow.mjs <workflow-base.json> <salida.json> <telegram-chat-id>');
}

// Se toma un workflow vivo únicamente para heredar el secreto del cron y la
// credencial cifrada de Telegram. Ninguno de los dos queda escrito en Git.
const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
const source = Array.isArray(parsed) ? parsed[0] : parsed;
const sourceHttp = source?.nodes?.find(node => node.name === 'HTTP Request');
const sourceTelegram = source?.nodes?.find(node => node.type === 'n8n-nodes-base.telegram');
if (!sourceHttp || !sourceTelegram?.credentials?.telegramApi) {
  throw new Error('El workflow base no contiene HTTP autenticado y credencial Telegram');
}

const endpoint = String(sourceHttp.parameters?.url || '')
  .replace('/api/cron/publish-combinada', '/api/cron/personal-market-report');
if (!endpoint.includes('/api/cron/personal-market-report') || !endpoint.includes('secret=')) {
  throw new Error('No se pudo conservar la autenticación del cron');
}

const schedule = {
  id: 'bf280c1a-eec8-4fc9-bbaa-4dd20cb3f001',
  name: 'Informe diario 08:00',
  type: 'n8n-nodes-base.scheduleTrigger',
  typeVersion: 1.3,
  position: [-720, 0],
  parameters: {
    rule: {
      interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }],
    },
  },
};

const manual = {
  id: 'bf280c1a-eec8-4fc9-bbaa-4dd20cb3f002',
  name: 'Ejecución manual',
  type: 'n8n-nodes-base.manualTrigger',
  typeVersion: 1,
  position: [-720, 180],
  parameters: {},
};

const gate = {
  id: 'bf280c1a-eec8-4fc9-bbaa-4dd20cb3f003',
  name: 'Preparar fecha',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-480, 0],
  parameters: {
    jsCode: `const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const state = $getWorkflowStaticData('global');
if (state.lastPersonalMarketReportDate === date) return [];
return [{ json: { date } }];`,
  },
};

const download = {
  ...structuredClone(sourceHttp),
  id: 'bf280c1a-eec8-4fc9-bbaa-4dd20cb3f004',
  name: 'Descargar CSV',
  position: [-230, 0],
  parameters: {
    url: `={{ ${JSON.stringify(`${endpoint}&date=`)} + $json.date }}`,
    options: {
      response: {
        response: { neverError: false, fullResponse: false, responseFormat: 'file' },
      },
      timeout: 60000,
    },
  },
};
delete download.credentials;

const telegram = {
  ...structuredClone(sourceTelegram),
  id: 'bf280c1a-eec8-4fc9-bbaa-4dd20cb3f005',
  name: 'Enviar archivo personal',
  position: [30, 0],
  parameters: {
    resource: 'message',
    operation: 'sendDocument',
    chatId: String(chatId),
    binaryData: true,
    binaryPropertyName: 'data',
    additionalFields: {
      fileName: `={{ 'CF_mercados_' + $('Preparar fecha').item.json.date + '.csv' }}`,
      caption: `={{ 'CF Análisis — probabilidades y fiabilidad del ' + $('Preparar fecha').item.json.date + '. Incluye todas las líneas solicitadas, sin filtrar por cuota ni porcentajes.' }}`,
    },
  },
};

const register = {
  id: 'bf280c1a-eec8-4fc9-bbaa-4dd20cb3f006',
  name: 'Registrar envío',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [300, 0],
  parameters: {
    jsCode: `const sent = $input.first()?.json || {};
const date = $('Preparar fecha').item.json.date;
if (!sent.message_id && !sent.result?.message_id) throw new Error('Telegram no confirmó el documento');
const state = $getWorkflowStaticData('global');
state.lastPersonalMarketReportDate = date;
state.lastPersonalMarketReportMessageId = sent.message_id || sent.result.message_id;
return [{ json: { ok: true, date, messageId: state.lastPersonalMarketReportMessageId } }];`,
  },
};

const workflow = {
  id: 'CFPersonalMarkets1',
  name: 'CF MERCADOS PERSONAL',
  active: true,
  nodes: [schedule, manual, gate, download, telegram, register],
  connections: {
    'Informe diario 08:00': { main: [[{ node: 'Preparar fecha', type: 'main', index: 0 }]] },
    'Ejecución manual': { main: [[{ node: 'Preparar fecha', type: 'main', index: 0 }]] },
    'Preparar fecha': { main: [[{ node: 'Descargar CSV', type: 'main', index: 0 }]] },
    'Descargar CSV': { main: [[{ node: 'Enviar archivo personal', type: 'main', index: 0 }]] },
    'Enviar archivo personal': { main: [[{ node: 'Registrar envío', type: 'main', index: 0 }]] },
  },
  settings: { timezone: 'Europe/Madrid', executionOrder: 'v1' },
  pinData: {},
  description: 'Envía cada día a las 08:00 de Europe/Madrid un CSV personal con 60 líneas de córners y goles por partido, sin filtros de cuota, probabilidad ni fiabilidad.',
};

writeFileSync(outputPath, `${JSON.stringify([workflow], null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  id: workflow.id,
  name: workflow.name,
  nodes: workflow.nodes.map(node => node.name),
  outputPath,
}, null, 2));
