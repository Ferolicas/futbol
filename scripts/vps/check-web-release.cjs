// Launch an isolated standalone on an ephemeral loopback port, then exercise
// routes and their generated assets before it can replace the live process.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');

async function check(base) {
  let root;
  for (const [route, status] of [['/', 200], ['/sign-in', 200], ['/dashboard', 307], ['/api/auth/session', 200], ['/api/free/visit', 401]]) {
    const response = await fetch(base + route, { redirect: 'manual', method: route === '/api/free/visit' ? 'POST' : 'GET', signal: AbortSignal.timeout(15000) });
    if (response.status !== status) throw Error(`${route}: HTTP ${response.status}, expected ${status}`);
    const body = await response.text();
    if (route === '/') root = body;
  }
  const assets = [...new Set([...root.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+)(?:\?[^" ]*)?"/g)].map(m => m[1]))];
  if (!assets.length) throw Error('Home has no generated assets');
  for (const asset of assets) {
    const response = await fetch(base + asset, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error(`Missing generated asset: ${asset}`);
    await response.arrayBuffer();
  }
  console.log(`WEB_SMOKE_OK: routes + ${assets.length} assets`);
}

(async () => {
  if (process.argv[2]?.startsWith('http')) return check(process.argv[2]);
  const runtime = path.resolve(process.argv[2]);
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(runtime, 'server.js')], {
    cwd: runtime, env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
  process.on('exit', stop);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw Error('Candidate exited before healthcheck');
      try { const r = await fetch(`http://127.0.0.1:${port}/sign-in`, { signal: AbortSignal.timeout(1000) }); await r.arrayBuffer(); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw Error('Candidate did not become ready');
    await check(`http://127.0.0.1:${port}`);
  } finally {
    stop();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    if (child.exitCode === null) await once(child, 'exit');
    clearTimeout(timer);
    process.removeListener('exit', stop);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
