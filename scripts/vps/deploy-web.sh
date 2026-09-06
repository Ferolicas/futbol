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

# Snapshot PM2 for an automatic rollback; these files may contain environment
# values and stay private on the VPS, outside Git.
pm2 jlist > "$RELEASE_DIR/pm2-before.json"
node - "$RELEASE_DIR" <<'JS'
const fs = require('node:fs');
const dir = process.argv[2];
const processInfo = JSON.parse(fs.readFileSync(`${dir}/pm2-before.json`)).find(p => p.name === 'cfanalisis-web');
if (!processInfo) throw Error('cfanalisis-web is not registered in PM2');
const previous = processInfo.pm2_env;
const config = { name: 'cfanalisis-web', script: previous.pm_exec_path, cwd: previous.pm_cwd,
  interpreter: previous.exec_interpreter || 'node', node_args: previous.node_args || [],
  exec_mode: 'fork', autorestart: true, env: { ...(previous.env || {}), NODE_ENV: 'production', PORT: previous.PORT || 3000 } };
fs.writeFileSync(`${dir}/rollback.config.json`, JSON.stringify({ apps: [config] }), { mode: 0o600 });
fs.writeFileSync(`${dir}/release.config.json`, JSON.stringify({ apps: [{ ...config, script: `${dir}/.next/standalone/server.js`, cwd: `${dir}/.next/standalone` }] }), { mode: 0o600 });
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
const dir = process.argv[2];
const active = JSON.parse(fs.readFileSync(`${dir}/pm2-after.json`)).find(p => p.name === 'cfanalisis-web');
if (active?.pm2_env?.pm_exec_path !== `${dir}/.next/standalone/server.js`) throw Error('PM2 did not activate the candidate runtime');
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
