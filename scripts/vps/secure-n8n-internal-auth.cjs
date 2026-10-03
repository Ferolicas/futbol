#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKFLOW_IDS = ['yrqca9FJFPClDu8H', 'PicksPremiumDia1'];
const INTERNAL_HTTP_NODES = new Set([
  'HTTP Request', 'Feed Futbol', 'Feed Baseball', 'Imagen Futbol', 'Imagen Baseball',
]);
const TELEGRAM_CREDENTIAL_NAME = 'Telegram account';
const INTERNAL_CREDENTIAL_NAME = 'CF Internal API Bearer';

function command(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', ...options });
}

function n8nEnvironment() {
  const processes = JSON.parse(command('pm2', ['jlist']));
  const processInfo = processes.find(item => item.name === 'n8n');
  if (!processInfo) throw new Error('n8n is not registered in PM2');
  return { ...process.env, ...processInfo.pm2_env };
}

function envValue(file, name) {
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .find(entry => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is missing from ${file}`);
  let value = line.slice(name.length + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value.length < 32) throw new Error(`${name} is too short`);
  return value;
}

function stripLegacySecrets(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/([?&])secret=[^&\s'"`]+(&|$)/g, (_match, prefix, tail) => (
      tail === '&' ? prefix : ''
    ))
    .replace(/([?&])secret=[^&\s'"`]+/g, '')
    .replace(/(["'])\s*\+\s*(["'])&date=/g, '$1 + $2?date=');
}

function sanitizeParameters(value) {
  if (typeof value === 'string') return stripLegacySecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeParameters);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeParameters(item)]));
}

function loadExport(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function psql(env, sql) {
  return command('psql', [
    '-h', env.DB_POSTGRESDB_HOST,
    '-p', String(env.DB_POSTGRESDB_PORT || 5432),
    '-U', env.DB_POSTGRESDB_USER,
    '-d', env.DB_POSTGRESDB_DATABASE,
    '-At', '-c', sql,
  ], { env: { ...env, PGPASSWORD: env.DB_POSTGRESDB_PASSWORD } }).trim();
}

function main() {
  const env = n8nEnvironment();
  const cronSecret = envValue('/apps/futbol/.env', 'CRON_SECRET');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-secure-'));
  fs.chmodSync(temp, 0o700);
  try {
    const userId = psql(env, 'SELECT id FROM "user" ORDER BY "createdAt" LIMIT 1');
    if (!userId) throw new Error('n8n owner user not found');

    const credentialsFile = path.join(temp, 'credentials.json');
    command('n8n', ['export:credentials', '--all', '--decrypted', `--output=${credentialsFile}`], {
      env, stdio: ['ignore', 'ignore', 'inherit'],
    });
    const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    const telegram = credentials.find(item => item.type === 'telegramApi' && item.name === TELEGRAM_CREDENTIAL_NAME);
    if (!telegram) throw new Error('Telegram credential not found');
    const existingInternal = credentials.find(item => item.type === 'httpHeaderAuth' && item.name === INTERNAL_CREDENTIAL_NAME);
    const internalId = existingInternal?.id || randomBytes(12).toString('base64url');
    fs.writeFileSync(credentialsFile, JSON.stringify([{
      id: internalId,
      name: INTERNAL_CREDENTIAL_NAME,
      type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: `Bearer ${cronSecret}` },
    }]), { mode: 0o600 });
    const credentialImportArgs = ['import:credentials', `--input=${credentialsFile}`];
    if (!existingInternal) credentialImportArgs.push(`--userId=${userId}`);
    command('n8n', credentialImportArgs, {
      env,
    });

    for (const id of WORKFLOW_IDS) {
      const workflowFile = path.join(temp, `${id}.json`);
      command('n8n', ['export:workflow', `--id=${id}`, `--output=${workflowFile}`], {
        env, stdio: ['ignore', 'ignore', 'inherit'],
      });
      const workflow = loadExport(workflowFile);
      for (const node of workflow.nodes || []) {
        node.parameters = sanitizeParameters(node.parameters || {});
        if (node.type === 'n8n-nodes-base.httpRequest' && INTERNAL_HTTP_NODES.has(node.name)) {
          node.parameters.authentication = 'genericCredentialType';
          node.parameters.genericAuthType = 'httpHeaderAuth';
          node.credentials = {
            ...(node.credentials || {}),
            httpHeaderAuth: { id: internalId, name: INTERNAL_CREDENTIAL_NAME },
          };
        }
        if (node.name === 'Enviar Futbol' || node.name === 'Enviar Baseball') {
          const isBaseball = node.name === 'Enviar Baseball';
          node.type = 'n8n-nodes-base.telegram';
          node.typeVersion = 1.2;
          node.credentials = {
            telegramApi: { id: telegram.id, name: telegram.name },
          };
          node.parameters = {
            resource: 'message',
            operation: isBaseball ? 'sendDocument' : 'sendPhoto',
            chatId: '-1003870511303',
            binaryData: true,
            binaryPropertyName: 'data',
            additionalFields: {
              fileName: isBaseball ? 'cfanalisis-baseball.png' : 'cfanalisis-futbol.png',
            },
          };
        }
      }
      const serialized = JSON.stringify([workflow]);
      if (serialized.includes('secret=')) throw new Error(`Legacy URL secret remains in ${workflow.name}`);
      if (/api\.telegram\.org\/bot/i.test(serialized)) throw new Error(`Plain Telegram token remains in ${workflow.name}`);
      fs.writeFileSync(workflowFile, serialized, { mode: 0o600 });
      command('n8n', ['import:workflow', `--input=${workflowFile}`], {
        env,
      });
      command('n8n', ['publish:workflow', `--id=${id}`], { env });
    }

    command('pm2', ['restart', 'n8n', '--update-env'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`Secured ${WORKFLOW_IDS.length} active n8n workflows.`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main();
