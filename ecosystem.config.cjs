// ─────────────────────────────────────────────────────────────────────────────
// ecosystem.config.cjs — pm2 para el worker partido en 2 procesos (Fase 1).
//
// Ambos procesos corren EL MISMO código (apps/cfanalisis-worker/src/index.ts),
// diferenciados solo por WORKER_ROLE. Comparten el mismo Redis local, así que
// BullMQ enruta cada job al proceso que tiene el Worker de esa cola:
//
//   cfanalisis-rt    → WORKER_ROLE=realtime: servidor HTTP/WS (:8080) +
//                      futbol-live + baseball-live. Liviano: su event loop
//                      NUNCA ejecuta jobs CPU-bound, así que /health y los
//                      ticks de 20s jamás se congelan.
//   cfanalisis-heavy → WORKER_ROLE=heavy: todo lo demás (daily, analyze,
//                      retrain, finalize, calibrate, fixtures, odds, lineups,
//                      cleanup, baseball…). Sin servidor HTTP.
//
// El .env lo carga el propio worker (env-bootstrap.ts) por RUTA ABSOLUTA al
// repo, así que aquí solo inyectamos WORKER_ROLE (+ PORT para el realtime).
//
// Arranque/activación en el VPS (ver mensaje de la Fase 1 para el detalle):
//   pm2 delete cfanalisis-worker
//   pm2 start /apps/futbol/ecosystem.config.cjs
//   pm2 save
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');

const cwd = '/apps/futbol/apps/cfanalisis-worker';
// tsx instalado como devDependency del worker (package.json). interpreter:'none'
// + script=binario es el patrón pm2 para ejecutar un binario directamente.
const tsx = path.join(cwd, 'node_modules', '.bin', 'tsx');

module.exports = {
  apps: [
    {
      name: 'cfanalisis-rt',
      cwd,
      script: tsx,
      args: 'src/index.ts',
      interpreter: 'none',
      env: { WORKER_ROLE: 'realtime', PORT: '8080' },
      autorestart: true,
      // El realtime debe ser estable y liviano; si por una fuga llegara a 1.5G
      // algo va mal → reinicio preventivo (no interrumpe ningún job pesado,
      // aquí no corren).
      max_memory_restart: '1500M',
    },
    {
      name: 'cfanalisis-heavy',
      cwd,
      script: tsx,
      args: 'src/index.ts',
      interpreter: 'none',
      env: { WORKER_ROLE: 'heavy' },
      autorestart: true,
      // SIN max_memory_restart: retrain/analyze pueden usar varios GB
      // legítimamente; matarlos a mitad sería el "colgado" que evitamos.
      // La gestión fina de memoria va en una fase posterior.
    },
  ],
};
