#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CREDENTIAL_NAME = 'Telegram CF Análisis Diario';
const REQUIRED_CHATS = ['-1003910091350'];

function command(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', ...options });
}

function n8nEnvironment() {
  const processes = JSON.parse(command('pm2', ['jlist']));
  const processInfo = processes.find(item => item.name === 'n8n');
  if (!processInfo) throw new Error('n8n no está registrado en PM2');
  return { ...process.env, ...processInfo.pm2_env };
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

async function readToken() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 512) throw new Error('Entrada demasiado larga');
  }
  const token = value.trim();
  if (!/^[0-9]{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('Formato de token inválido');
  return token;
}

async function telegramCall(token, method, params = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(`Telegram rechazó ${method}: ${body.description || response.status}`);
  }
  return body.result;
}

async function main() {
  const token = await readToken();
  const bot = await telegramCall(token, 'getMe');
  for (const chatId of REQUIRED_CHATS) await telegramCall(token, 'getChat', { chat_id: chatId });

  const env = n8nEnvironment();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-telegram-'));
  fs.chmodSync(temp, 0o700);
  try {
    const credentialsFile = path.join(temp, 'credentials.json');
    command('n8n', ['export:credentials', '--all', '--decrypted', `--output=${credentialsFile}`], {
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    const telegram = credentials.find(item => item.type === 'telegramApi' && item.name === CREDENTIAL_NAME);
    const credentialId = telegram?.id || randomBytes(12).toString('base64url');
    fs.writeFileSync(credentialsFile, JSON.stringify([{
      id: credentialId,
      name: CREDENTIAL_NAME,
      type: 'telegramApi',
      data: { accessToken: token },
    }]), { mode: 0o600 });
    const importArgs = ['import:credentials', `--input=${credentialsFile}`];
    if (!telegram) {
      const userId = psql(env, 'SELECT id FROM "user" ORDER BY "createdAt" LIMIT 1');
      if (!userId) throw new Error('No se encontró el propietario de n8n');
      importArgs.push(`--userId=${userId}`);
    }
    command('n8n', importArgs, { env });
    command('pm2', ['restart', 'n8n', '--update-env'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(JSON.stringify({
      ok: true,
      botId: bot.id,
      username: bot.username || null,
      chatsVerified: REQUIRED_CHATS.length,
      credentialId,
      credentialName: CREDENTIAL_NAME,
    }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
