#!/usr/bin/env bash
# Build immutable web releases. Never run next build over the live runtime.
set -euo pipefail
umask 077
REPO_DIR="$(git rev-parse --show-toplevel)"
cd "$REPO_DIR"
RELEASES_DIR="$REPO_DIR/.web-releases"
mkdir -p "$RELEASES_DIR"
RELEASE_DIR="$(mktemp -d "$RELEASES_DIR/release-$(git rev-parse --short HEAD)-XXXXXX")"
RUNTIME_DIR="$RELEASE_DIR/.next/standalone"
LOG_DIR="/var/log/cfanalisis"

# PM2 abre stdout/stderr despues de bajar privilegios. Sus rutas por defecto
# viven bajo /root/.pm2 y no son accesibles para el usuario de la aplicacion.
install -d -o cfanalisis -g cfanalisis -m 0750 "$LOG_DIR"
touch "$LOG_DIR/web-out.log" "$LOG_DIR/web-error.log"
chown cfanalisis:cfanalisis "$LOG_DIR/web-out.log" "$LOG_DIR/web-error.log"
chmod 0640 "$LOG_DIR/web-out.log" "$LOG_DIR/web-error.log"

# Snapshot PM2 for an automatic rollback; these files may contain environment
# values and stay private on the VPS, outside Git.
pm2 jlist > "$RELEASE_DIR/pm2-before.json"
node - "$RELEASE_DIR" <<'JS'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const dir = process.argv[2];
const processList = JSON.parse(fs.readFileSync(`${dir}/pm2-before.json`));
const webProcesses = processList.filter(p => p.name === 'cfanalisis-web');
const processInfo = webProcesses[0];
if (!processInfo) throw Error('cfanalisis-web is not registered in PM2');
const previous = processInfo.pm2_env;
const config = { name: 'cfanalisis-web', script: previous.pm_exec_path, cwd: previous.pm_cwd,
  interpreter: previous.exec_interpreter || 'node', node_args: previous.node_args || [], autorestart: true,
  out_file: '/var/log/cfanalisis/web-out.log',
  error_file: '/var/log/cfanalisis/web-error.log', merge_logs: true,
  env: { ...(previous.env || {}), NODE_ENV: 'production', PORT: previous.PORT || 3000,
    HOSTNAME: '127.0.0.1' } };
const serviceUid = Number(execFileSync('id', ['-u', 'cfanalisis'], { encoding: 'utf8' }).trim());
const previousPrivileges = Number(previous.uid) === serviceUid
  ? { uid: 'cfanalisis', gid: 'cfanalisis' }
  : {};
const rollbackMode = previous.exec_mode === 'cluster_mode' ? 'cluster' : 'fork';
const configuredInstances = Number(previous.env?.CF_WEB_INSTANCES);
const desiredInstances = Number.isInteger(configuredInstances) && configuredInstances >= 2
  ? configuredInstances
  : 2;
fs.writeFileSync(`${dir}/rollback.config.json`, JSON.stringify({ apps: [{ ...config,
  ...previousPrivileges,
  exec_mode: rollbackMode, instances: webProcesses.length }] }), { mode: 0o600 });
fs.writeFileSync(`${dir}/release.config.json`, JSON.stringify({ apps: [{ ...config,
  uid: 'cfanalisis', gid: 'cfanalisis',
  script: `${dir}/.next/standalone/server.js`, cwd: `${dir}/.next/standalone`,
  exec_mode: 'cluster', instances: desiredInstances }] }), { mode: 0o600 });
fs.writeFileSync(`${dir}/previous-runtime`, require('node:path').dirname(previous.pm_exec_path));
JS

git archive HEAD | tar -x -C "$RELEASE_DIR"
cp .env "$RELEASE_DIR/.env"
(
  cd "$RELEASE_DIR"
  NODE_ENV=development npm install --include=dev --no-audit --no-fund
  NODE_ENV=production npm run build
)
cp .env "$RUNTIME_DIR/.env"
mkdir -p "$RUNTIME_DIR/public" "$RUNTIME_DIR/.next/static"
cp -a "$RELEASE_DIR/public/." "$RUNTIME_DIR/public/"
cp -a "$RELEASE_DIR/.next/static/." "$RUNTIME_DIR/.next/static/"
# Keep the previous build's asset hashes available for already-open tabs.
PREVIOUS_RUNTIME="$(cat "$RELEASE_DIR/previous-runtime")"
PREVIOUS_BUILD="$(dirname "$PREVIOUS_RUNTIME")"
if [ -d "$PREVIOUS_BUILD/static" ]; then
  cp -an "$PREVIOUS_BUILD/static/." "$RUNTIME_DIR/.next/static/"
fi
node scripts/vps/check-web-release.cjs "$RUNTIME_DIR"

# El proceso nunca corre como root. El runtime queda legible pero no
# modificable por el usuario de la app; solo un cache existente puede escribir.
chgrp cfanalisis "$RELEASES_DIR" "$RELEASE_DIR" "$RELEASE_DIR/.next"
chmod 750 "$RELEASES_DIR" "$RELEASE_DIR" "$RELEASE_DIR/.next"
chown -R root:cfanalisis "$RUNTIME_DIR"
find "$RUNTIME_DIR" -type d -exec chmod 750 {} +
find "$RUNTIME_DIR" -type f -exec chmod 640 {} +
# Next crea entradas de caché ISR/prerender después de arrancar. El directorio
# debe existir antes de bajar privilegios; si no, el usuario cfanalisis intenta
# crearlo dentro de un runtime root:cfanalisis 0750 y recibe EACCES.
install -d -o cfanalisis -g cfanalisis -m 0750 "$RUNTIME_DIR/.next/cache"

activate() {
  # This PM2 version does not update pm_exec_path for an existing app through
  # startOrReload. Replace only this named process after candidate validation.
  if pm2 describe cfanalisis-web > /dev/null 2>&1; then
    pm2 delete cfanalisis-web > /dev/null || return 1
  fi
  pm2 start "$1" --only cfanalisis-web --update-env
}
rollback() {
  echo 'Candidate failed after activation; restoring the previous runtime'
  activate "$RELEASE_DIR/rollback.config.json"
  pm2 save
}
if ! activate "$RELEASE_DIR/release.config.json"; then
  rollback
  exit 1
fi
pm2 jlist > "$RELEASE_DIR/pm2-after.json"
if ! node - "$RELEASE_DIR" <<'JS'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const dir = process.argv[2];
const expected = JSON.parse(fs.readFileSync(`${dir}/release.config.json`)).apps[0];
const active = JSON.parse(fs.readFileSync(`${dir}/pm2-after.json`)).filter(p => p.name === 'cfanalisis-web');
const serviceUid = Number(execFileSync('id', ['-u', 'cfanalisis'], { encoding: 'utf8' }).trim());
if (active.length !== expected.instances) throw Error(`PM2 started ${active.length}/${expected.instances} web instances`);
if (active.some(p => p.pm2_env?.pm_exec_path !== `${dir}/.next/standalone/server.js`)) throw Error('PM2 did not activate the candidate runtime');
if (active.some(p => Number(p.pm2_env?.uid) !== serviceUid)) throw Error('PM2 did not drop web process privileges');
JS
then rollback; exit 1; fi
HEALTHY=0
for attempt in 1 2 3 4 5; do
  if node scripts/vps/check-web-release.cjs http://127.0.0.1:3000; then HEALTHY=1; break; fi
  sleep 1
done
if [ "$HEALTHY" != 1 ]; then rollback; exit 1; fi
pm2 save
printf '%s\n' "$RELEASE_DIR" > "$RELEASES_DIR/current"
echo "WEB_RELEASE_ACTIVE: $(basename "$RELEASE_DIR")"
