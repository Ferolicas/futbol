#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

const [inputPath, outputPath, chatId] = process.argv.slice(2);
if (!inputPath || !outputPath || !/^\d{6,20}$/.test(String(chatId || ''))) {
  throw new Error('Uso: node scripts/build-n8n-personal-market-report-workflow.mjs <workflow-base.json> <salida.json> <telegram-chat-id>');
}

// Se toma un workflow vivo únicamente para heredar la credencial cifrada de
// Telegram. El informe web usa la sesión privada del propietario; ningún
// secreto de cron viaja en los enlaces.
const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
const source = Array.isArray(parsed) ? parsed[0] : parsed;
const sourceTelegram = source?.nodes?.find(node => node.type === 'n8n-nodes-base.telegram');
if (!sourceTelegram?.credentials?.telegramApi) {
  throw new Error('El workflow base no contiene la credencial Telegram');
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
// La deduplicación aplica al cron. Una ejecución manual/CLI es una orden
// explícita del propietario para reenviar el informe del día.
if ($execution.mode === 'trigger' && state.lastPersonalMarketReportDate === date) return [];
const message = [
  '⚽ INFORME DE FÚTBOL · CÓRNERS 1.ª PARTE',
  'https://cfanalisis.com/ferney/informes?deporte=futbol&date=' + date,
  '',
  '⚾ INFORME DE BÉISBOL',
  'https://cfanalisis.com/ferney/informes?deporte=baseball&date=' + date,
  '',
  'Fútbol: expectativa de córners en la primera mitad, últimos 5 e historial 2026 por equipo. Béisbol conserva todos sus mercados.',
].join(String.fromCharCode(10));
return [{ json: { date, message } }];`,
  },
};

const telegram = {
  ...structuredClone(sourceTelegram),
  id: 'bf280c1a-eec8-4fc9-bbaa-4dd20cb3f005',
  name: 'Enviar informes interactivos',
  position: [-170, 0],
  parameters: {
    resource: 'message',
    operation: 'sendMessage',
    chatId: String(chatId),
    text: '={{ $json.message }}',
    additionalFields: {
      disableWebPagePreview: true,
      appendAttribution: false,
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
  nodes: [schedule, manual, gate, telegram, register],
  connections: {
    'Informe diario 08:00': { main: [[{ node: 'Preparar fecha', type: 'main', index: 0 }]] },
    'Ejecución manual': { main: [[{ node: 'Preparar fecha', type: 'main', index: 0 }]] },
    'Preparar fecha': { main: [[{ node: 'Enviar informes interactivos', type: 'main', index: 0 }]] },
    'Enviar informes interactivos': { main: [[{ node: 'Registrar envío', type: 'main', index: 0 }]] },
  },
  settings: { timezone: 'Europe/Madrid', executionOrder: 'v1' },
  pinData: {},
  description: 'Envía cada día a las 08:00 de Europe/Madrid los enlaces privados a los informes interactivos de fútbol y béisbol.',
};

writeFileSync(outputPath, `${JSON.stringify([workflow], null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  id: workflow.id,
  name: workflow.name,
  nodes: workflow.nodes.map(node => node.name),
  outputPath,
}, null, 2));
