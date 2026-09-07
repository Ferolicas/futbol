import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_REALTIME_TOPICS,
  readRealtimeTokenFromProtocols,
  realtimeTopicsForUser,
  signRealtimeAccessToken,
  verifyRealtimeAccessToken,
} from '@cfanalisis/realtime-protocol/auth';
import {
  REALTIME_WS_PROTOCOL,
  REALTIME_WS_TOKEN_PREFIX,
} from '@cfanalisis/realtime-protocol';

const SECRET = 'test-worker-secret-with-at-least-32-characters';
const OTHER_SECRET = 'different-test-worker-secret-with-32-characters';
const USER_ID = 'a54ca22f-bb25-446e-a5a8-767b955ed4a8';

test('el JWT realtime dura cinco minutos y solo concede topics del usuario', async () => {
  const before = Date.now();
  const access = await signRealtimeAccessToken({
    userId: USER_ID,
    role: 'user',
    workerSecret: SECRET,
  });
  const verified = await verifyRealtimeAccessToken(access.token, SECRET);

  assert.ok(verified);
  assert.equal(verified.userId, USER_ID);
  assert.equal(verified.role, 'user');
  assert.deepEqual(verified.topics, [...PUBLIC_REALTIME_TOPICS, `chat-${USER_ID}`]);
  assert.ok(access.expiresAt >= before + 299_000);
  assert.ok(access.expiresAt <= Date.now() + 301_000);
  assert.equal(verified.topics.includes('chat-admin'), false);
  assert.equal(verified.topics.includes('chat-another-user'), false);
});

test('admin puede escuchar chat-admin sin poder inventar chats ajenos', () => {
  const topics = realtimeTopicsForUser(USER_ID, 'admin');
  assert.equal(topics.includes('chat-admin'), true);
  assert.equal(topics.includes(`chat-${USER_ID}`), true);
  assert.equal(topics.includes('chat-another-user'), false);
});

test('rechaza firma incorrecta, token alterado y secretos débiles', async () => {
  const { token } = await signRealtimeAccessToken({ userId: USER_ID, workerSecret: SECRET });
  assert.equal(await verifyRealtimeAccessToken(token, OTHER_SECRET), null);
  assert.equal(await verifyRealtimeAccessToken(`${token.slice(0, -1)}x`, SECRET), null);
  await assert.rejects(
    signRealtimeAccessToken({ userId: USER_ID, workerSecret: 'weak' }),
    /missing or too short/,
  );
});

test('extrae la credencial del subprotocolo y nunca necesita query params', async () => {
  const { token } = await signRealtimeAccessToken({ userId: USER_ID, workerSecret: SECRET });
  const header = `${REALTIME_WS_PROTOCOL}, ${REALTIME_WS_TOKEN_PREFIX}${token}`;
  assert.equal(readRealtimeTokenFromProtocols(header), token);
  assert.equal(readRealtimeTokenFromProtocols(`${REALTIME_WS_TOKEN_PREFIX}${token}`), null);
  assert.equal(readRealtimeTokenFromProtocols(undefined), null);
});

test('las barreras de seguridad permanecen en las rutas críticas', async () => {
  const { readFile } = await import('node:fs/promises');
  const [client, server, chat, workerIndex] = await Promise.all([
    readFile(new URL('../hooks/useWorkerSocket.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/cfanalisis-worker/src/server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/chat/route.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/cfanalisis-worker/src/index.ts', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(client, /NEXT_PUBLIC_(?:WS_TOKEN|WORKER_SECRET)/);
  assert.doesNotMatch(client, /\?secret=/);
  assert.match(client, /Sec-WebSocket-Protocol|REALTIME_WS_PROTOCOL/);
  assert.match(server, /preValidation/);
  assert.match(server, /statusCode >= 500 \? 'internal_error'/);
  assert.match(server, /app\.get\('\/queues\/:name\/status'[\s\S]*requireAuth/);
  assert.match(chat, /update = update\.eq\('user_id', user\.id\)/);
  assert.match(workerIndex, /process\.env\.WORKER_HOST \|\| '127\.0\.0\.1'/);
});
